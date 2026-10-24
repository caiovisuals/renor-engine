import type Database from '../db/sqlite';
import {
  dedupeKeyFor,
  insertStructuredRows,
  type NewStructuredRow,
} from '../context/rowStore';
import {
  LocalRulesDecisionModel,
  NUMERIC_FACT_RE,
  STATIVE_CUE_RE,
  defaultDecisionModel,
  type DecisionModel,
  type FactCandidate,
} from './decision-model';

/**
 * C2 facts write-path (ADR-0003 §4/§6, component-matrix C2): save-time typed
 * numeric-fact capture from real markdown through the REAL index pipeline
 * (indexVault → extraction → structured-row store). Facts flow into the C0
 * rowStore, whose identity-keyed supersession extends the battle-tested
 * lifecycle bitemporal model (valid_from/valid_to) to extracted rows — the
 * markdown Memory Events Ledger stays `_mcp_`-lifecycle-only per
 * inventory-facts (its semantics do not apply to extracted note facts), so
 * extracted facts are NOT appended there.
 *
 * Flag gate: RENOR_FACTS_WRITE_PATH (default OFF). Flag off = zero decision
 * calls, zero new writes, byte-identical shipped behavior. The ask-time
 * evidence second pass is untouched (C2 is save-time; both compose).
 *
 * v1 schema only — no v2/v3/v4 prompt variants (five extractor KILLs). The
 * extractor is the local-rules path TODAY (no live model calls, quota=0); a
 * model-backed extractor plugs in through the DecisionModel seam.
 */

export const FACTS_EXTRACTION_VERSION = 'c2-facts-v1';

/** RENOR_FACTS_WRITE_PATH (default OFF). Opt in with 1/true/yes/on. */
export function factsWritePathEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_FACTS_WRITE_PATH ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Content dates: frontmatter `session_date`/`date`; unknown stays unknown (NULL — never `now`, never invented). */
const CONTENT_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:]+(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function contentValidFrom(frontmatter: Record<string, unknown>): string | null {
  for (const key of ['session_date', 'date']) {
    const raw = frontmatter[key];
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      return raw.toISOString().slice(0, 10); // YAML unquoted dates parse as Date; date-only UTC midnight
    }
    if (typeof raw === 'string' && CONTENT_DATE_RE.test(raw.trim())) return raw.trim();
  }
  return null;
}

/**
 * v1 numeric-fact candidates from gate-approved chunk text. Deterministic:
 * sentence-split, rule-matched value/unit/verb, note title as object (the
 * legacy extractor's same "note about one main entity" guidance). No model
 * call, no parse-failure mode — JSON/YAML parse errors cannot arise from a
 * local deterministic extractor by construction.
 */
export function extractFactCandidates(text: string, noteTitle: string): FactCandidate[] {
  if (!text || !text.trim()) return [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out: FactCandidate[] = [];
  for (const sentence of sentences) {
    if (LocalRulesDecisionModel.captureGate(sentence) !== 'fact') continue;
    const valueMatch = NUMERIC_FACT_RE.exec(sentence);
    if (!valueMatch) continue;
    const cueMatch = STATIVE_CUE_RE.exec(sentence);
    out.push({
      value: valueMatch[1].replace(',', '.'),
      unit: valueMatch[2] ? valueMatch[2].toLowerCase() : undefined,
      verb: cueMatch ? cueMatch[1].toLowerCase() : undefined,
      object: noteTitle,
      event: sentence.length > 300 ? sentence.slice(0, 300) : sentence,
    });
  }
  return out;
}

export interface CaptureNoteFactsArgs {
  notePath: string;
  noteTitle: string;
  frontmatter: Record<string, unknown>;
  /** Content hash at extraction time (cache invalidation key, ADR-0003 §4/§6). */
  sourceHash: string;
  /** The note's freshly written chunks with their real chunk ids (provenance proof). */
  chunks: Array<{ id: number; text: string }>;
}

export interface CaptureOutcome {
  rowsWritten: number;
  confirmBumps: number;
  decisions: number;
}

/**
 * Capture one note's typed facts: per-chunk capture-gate decision → candidate
 * extraction → dedupe adjudication against the current row with the same
 * dedupe identity → write (structured row, or confirm-count bump on
 * `identical`; a cross-note `identical` additionally writes the confirming
 * note's own source-scoped row so the fact survives either note's deletion). Adjudicates against the lowest-id current row so repeated
 * runs are deterministic. Hash-keyed skip: rows already present for
 * (source_path, source_hash, extraction_version) → zero decisions (the
 * pipeline additionally skips unchanged notes via note_hash before this runs).
 */
export async function captureNoteFacts(
  db: Database.Database,
  args: CaptureNoteFactsArgs,
  model: DecisionModel = defaultDecisionModel(),
): Promise<CaptureOutcome> {
  const hashSkip = db.prepare(
    `SELECT COUNT(*) AS c FROM structured_rows WHERE source_path = ? AND source_hash = ? AND extraction_version = ?`
  ).get(args.notePath, args.sourceHash, FACTS_EXTRACTION_VERSION) as { c: number };
  if (hashSkip.c > 0) return { rowsWritten: 0, confirmBumps: 0, decisions: 0 };

  const validFrom = contentValidFrom(args.frontmatter);
  const findCurrent = db.prepare(
    `SELECT id, source_path, payload_json FROM structured_rows
     WHERE row_kind = 'fact' AND scope = 'global' AND dedupe_key = ? AND valid_to IS NULL
     ORDER BY id LIMIT 1`
  );
  const bumpConfirm = db.prepare(
    `UPDATE structured_rows SET confirm_count = confirm_count + 1 WHERE row_kind = 'fact' AND scope = 'global' AND dedupe_key = ? AND valid_to IS NULL`
  );
  // Does THIS note already hold a current row for the identity? Guards the
  // cross-note confirm write against double-inserting when several chunks of
  // the same note adjudicate `identical` against the original note's row.
  const findOwnCurrent = db.prepare(
    `SELECT id FROM structured_rows
     WHERE row_kind = 'fact' AND scope = 'global' AND dedupe_key = ? AND source_path = ? AND valid_to IS NULL
     LIMIT 1`
  );

  let rowsWritten = 0;
  let confirmBumps = 0;
  let decisions = 0;

  for (const chunk of args.chunks) {
    const gate = await model.decide({ task: 'capture_gate', text: chunk.text });
    decisions++;
    if (gate.task !== 'capture_gate' || gate.decision !== 'fact') continue;

    for (const candidate of extractFactCandidates(chunk.text, args.noteTitle)) {
      const dedupeKey = dedupeKeyFor({
        rowKind: 'fact',
        sourcePath: args.notePath,
        sourceChunkId: chunk.id,
        sourceHash: args.sourceHash,
        extractionVersion: FACTS_EXTRACTION_VERSION,
        validFrom,
        payload: candidate,
      } as NewStructuredRow);
      const existing = findCurrent.get(dedupeKey) as
        | { id: number; source_path: string; payload_json: string }
        | undefined;
      const existingCandidate = existing
        ? (JSON.parse(existing.payload_json) as FactCandidate)
        : null;
      const adjudication = await model.decide({
        task: 'dedupe_adjudication',
        candidate,
        existing: existingCandidate,
      });
      decisions++;
      if (adjudication.task !== 'dedupe_adjudication') continue;
      if (adjudication.decision === 'identical') {
        bumpConfirm.run(dedupeKey);
        confirmBumps++;
        // Same-note `identical` (re-extraction/edit): bump only, no duplicate
        // row (original C2 behavior). Cross-note `identical` — this note is
        // NOT the source of the compared row — must ALSO write its own
        // source-scoped row: the dedupe key has no source, so a bump-only
        // write leaves the fact pinned solely to the original note's row,
        // whose FK cascade dies with that note while this note still asserts
        // the fact (unsurfaceable via the retrieval-hit join).
        if (!existing || existing.source_path === args.notePath) continue;
        const own = findOwnCurrent.get(dedupeKey, args.notePath);
        if (own) continue; // already captured from another chunk/run of this note
        insertStructuredRows(
          db,
          [
            {
              rowKind: 'fact',
              sourcePath: args.notePath,
              sourceChunkId: chunk.id,
              sourceHash: args.sourceHash,
              extractionVersion: FACTS_EXTRACTION_VERSION,
              validFrom,
              payload: candidate,
            },
          ],
          { skipSupersession: true }, // identical facts coexist: supersession would close the fact on the note that still asserts it
        );
        rowsWritten++;
        continue;
      }
      // 'updated' and 'distinct' both write; the rowStore's identity-keyed
      // supersession (never blanket newest-wins — N18 KILL) closes the
      // collided current row only when both content dates are known and the
      // new source is not older. NULL valid_from never supersedes.
      insertStructuredRows(db, [
        {
          rowKind: 'fact',
          sourcePath: args.notePath,
          sourceChunkId: chunk.id,
          sourceHash: args.sourceHash,
          extractionVersion: FACTS_EXTRACTION_VERSION,
          validFrom,
          payload: candidate,
        },
      ]);
      rowsWritten++;
    }
  }
  return { rowsWritten, confirmBumps, decisions };
}