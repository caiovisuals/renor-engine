import type Database from 'better-sqlite3';
import {
  dedupeKeyFor,
  insertStructuredRows,
  type NewStructuredRow,
  type RowKind,
  type StructuredRowPayload,
} from '../context/rowStore';
import { defaultDecisionModel, type DecisionModel } from './decision-model';

/**
 * Harmonized write-path adjudication layer (C2 write path × fleet extractors,
 * merge of PRs #126/#127/#130 with feat/c2-facts-writepath): the single
 * decision-before-write stage shared by every structured-row lane.
 *
 * Flow per candidate (in order, before any row is written):
 *   1. capture-gate / sensitivity-guardrail — one `capture_gate` decision per
 *      candidate on the best available source text (the chunk the candidate
 *      was attributed to, else the candidate's own key phrase). A `sensitive`
 *      decision BLOCKS the candidate: no row, no confirm bump (the Jev
 *      guardrail adapter expresses block/redact as capture-gate `sensitive`).
 *      Other gate outcomes never veto a typed candidate — the lane extractor
 *      already did the type-specific generation (H5 lesson: gating on the
 *      generic v1 gate's 'none' would silently destroy extractor yield).
 *   2. dedupe adjudication — one `dedupe_adjudication` decision against the
 *      current row with the same dedupe identity (lowest id, deterministic).
 *      Facts honor this branch's confirm-count + v11 unique-index semantics:
 *      `identical` bumps confirm_count (no duplicate row) and, cross-note,
 *      additionally writes the confirming note's own source-scoped row so the
 *      fact survives either note's deletion. Events/preferences restate the
 *      fleet's bitemporal semantics: the row is written through the rowStore's
 *      identity-keyed supersession (a newer dated restatement supersedes the
 *      old row; NULL dates never supersede — both stay current).
 *
 * Fail behavior: a decision error propagates to the pipeline's lane catch
 * (note hash reset, no rows cached) — the same never-cached contract as the
 * extractors. No vendor is hardcoded: `model` defaults to the local-rules
 * DecisionModel (zero network, zero cost); the Jev guardrail adapter plugs in
 * through the same seam.
 */

export interface LaneCandidate {
  /** The lane payload (fact/event/preference schema, ADR-0003 §4). */
  payload: StructuredRowPayload;
  /** The chunk the row's provenance points at (real chunk id). */
  sourceChunkId: number;
  /** Best available source text for the capture-gate/guardrail decision. */
  sourceText: string;
}

export interface AdjudicateRowsArgs {
  rowKind: RowKind;
  extractionVersion: string;
  notePath: string;
  /** Content hash at extraction time (cache invalidation key, ADR §4.2). */
  sourceHash: string;
  /** Content date (frontmatter session_date/date); NULL = unknown, never invented. */
  validFrom: string | null;
  candidates: LaneCandidate[];
}

export interface AdjudicationOutcome {
  rowsWritten: number;
  confirmBumps: number;
  decisions: number;
  /** Candidates blocked at the gate as `sensitive` (guardrail blocks). */
  blocked: number;
}

/**
 * Attribute a candidate to the chunk whose text contains its key phrase
 * (fact: value; event: event phrase; preference: statement). Plain,
 * deterministic substring match — provenance-correct when it matches, and the
 * caller falls back to the fleet's first-chunk attribution when it doesn't.
 */
export function chunkForCandidate(
  chunks: Array<{ id: number; text: string }>,
  payload: StructuredRowPayload,
): { chunkId: number; text: string } | null {
  const phrase = 'statement' in payload
    ? (payload as { statement?: string }).statement
    : 'when' in payload
      ? (payload as { event?: string }).event
      : 'value' in payload
        ? (payload as { value?: string }).value
        : undefined;
  if (!phrase) return null;
  const needle = phrase.toLowerCase();
  for (const chunk of chunks) {
    if (chunk.text.toLowerCase().includes(needle)) {
      return { chunkId: chunk.id, text: chunk.text };
    }
  }
  return null;
}

/**
 * Decide, then write — the harmonized single write path for one note's lane
 * candidates. Rows are written AT MOST ONCE per candidate: identical facts
 * bump the existing row's confirm_count (plus the cross-note coexist write),
 * everything else goes through `insertStructuredRows` (identity-keyed
 * supersession + migration v11's partial unique index closing the
 * same-identity insert race).
 */
export async function adjudicateAndWriteRows(
  db: Database.Database,
  args: AdjudicateRowsArgs,
  model: DecisionModel = defaultDecisionModel(),
): Promise<AdjudicationOutcome> {
  const findCurrent = db.prepare(
    `SELECT id, source_path, payload_json FROM structured_rows
     WHERE row_kind = ? AND scope = 'global' AND dedupe_key = ? AND valid_to IS NULL
     ORDER BY id LIMIT 1`
  );
  const bumpConfirm = db.prepare(
    `UPDATE structured_rows SET confirm_count = confirm_count + 1 WHERE row_kind = ? AND scope = 'global' AND dedupe_key = ? AND valid_to IS NULL`
  );
  // Does THIS note already hold a current row for the identity? Guards the
  // cross-note confirm write against double-inserting when several candidates
  // of the same note adjudicate `identical` against the original note's row.
  const findOwnCurrent = db.prepare(
    `SELECT id FROM structured_rows
     WHERE row_kind = ? AND scope = 'global' AND dedupe_key = ? AND source_path = ? AND valid_to IS NULL
     LIMIT 1`
  );

  let rowsWritten = 0;
  let confirmBumps = 0;
  let decisions = 0;
  let blocked = 0;

  for (const candidate of args.candidates) {
    // 1. Capture gate / sensitivity guardrail — BEFORE any write.
    const gate = await model.decide({ task: 'capture_gate', text: candidate.sourceText });
    decisions++;
    if (gate.task !== 'capture_gate') continue;
    if (gate.decision === 'sensitive') {
      blocked++;
      continue;
    }

    const row: NewStructuredRow = {
      rowKind: args.rowKind,
      sourcePath: args.notePath,
      sourceChunkId: candidate.sourceChunkId,
      sourceHash: args.sourceHash,
      extractionVersion: args.extractionVersion,
      validFrom: args.validFrom,
      payload: candidate.payload,
    };
    const dedupeKey = dedupeKeyFor(row);
    const existing = findCurrent.get(args.rowKind, dedupeKey) as
      | { id: number; source_path: string; payload_json: string }
      | undefined;
    const adjudication = await model.decide({
      task: 'dedupe_adjudication',
      rowKind: args.rowKind,
      candidate: candidate.payload,
      existing: existing ? (JSON.parse(existing.payload_json) as StructuredRowPayload) : null,
    });
    decisions++;
    if (adjudication.task !== 'dedupe_adjudication') continue;

    if (adjudication.decision === 'identical' && args.rowKind === 'fact') {
      // Facts: an identical restatement corroborates — bump confirm_count,
      // never double-write the same identity from the same adjudication.
      bumpConfirm.run(args.rowKind, dedupeKey);
      confirmBumps++;
      if (!existing || existing.source_path === args.notePath) continue;
      // Cross-note `identical` must ALSO write this note's own source-scoped
      // row (review FIX 1): the dedupe key has no source, so a bump-only
      // write leaves the fact pinned solely to the original note's row, whose
      // FK cascade dies with that note while this note still asserts it.
      const own = findOwnCurrent.get(args.rowKind, dedupeKey, args.notePath);
      if (own) continue; // already captured from another chunk/run of this note
      insertStructuredRows(
        db,
        [{ ...row, sourceChunkId: candidate.sourceChunkId }],
        { skipSupersession: true }, // identical facts coexist: supersession would close the fact on the note that still asserts it
      );
      rowsWritten++;
      continue;
    }
    // 'updated'/'distinct' — and events/preferences restating the same
    // identity — write through the rowStore: identity-keyed supersession
    // (never blanket newest-wins; NULL dates never supersede) + the v11
    // partial unique index closing the same-identity insert race.
    insertStructuredRows(db, [row]);
    rowsWritten++;
  }
  return { rowsWritten, confirmBumps, decisions, blocked };
}