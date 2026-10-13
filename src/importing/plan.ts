import { hashContent } from '../indexer/hasher';
import { identityKey } from '../retrieval/queryHelpers';
import { clampSessionDate } from '../retrieval/orchestrator';
import { deterministicEventId, tryNormalizeScope, validateCarriedFact } from './facts';
import { scopeSpellings } from '../mvp/scope';
import { destinationRelPath, renderNoteMarkdown } from './serialize';
import { ImportBundle, ImportFact, ImportNote } from './types';
import { secretGuardEnabled } from '../extraction/secretGuard';
import { leaveOutFlagged, type GuardSkips } from './secretScreen';
import { IMPORT_SOURCE_PREFIX, isImportSource } from '../memory/sourceName';

/**
 * The ledger source of a carried fact. A bundle file can name any source, and so can the `--event-source` flag, so without
 * this an imported fact could read as the agent that saved it (its author is what get_context shows and marks); an import
 * always says it is one.
 */
const importedLedgerSource = (carried: string): string => (isImportSource(carried) ? carried : `${IMPORT_SOURCE_PREFIX}${carried}`);

/**
 * The plan is pure: it decides what *would* be written and what is deliberately
 * not carried, and reports counts only — never memory text.
 */

export interface PlannedNote {
  relPath: string;
  content: string;
  contentHash: string;
  /** True when the source's original bytes were carried rather than reconstructed. */
  fromOriginalBytes: boolean;
  chunkLines: Array<{ startLine: number; endLine: number }>;
  /** Chunks whose text could not be located in the bytes written. */
  chunksNotLocated: number;
  /** Of those, how many inherited the source index's stored span. */
  chunksSpanInherited: number;
  note: ImportNote;
}

export interface PlannedEvent {
  id: string;
  at: string;
  kind: 'store';
  subject: string;
  predicate: string;
  object: string;
  scope: string;
  source: string;
}

export interface SkipCount {
  reason: string;
  count: number;
}

export interface ImportPlan {
  sourceLabel: string;
  namespace: string;
  notes: PlannedNote[];
  events: PlannedEvent[];
  skipped: {
    duplicateNotePath: number;
    emptyNoteBody: number;
    events: SkipCount[];
    /** Only while RENOR_SECRET_GUARD is on: the notes and facts left out because they look like a secret, and why. */
    secretGuard?: GuardSkips;
  };
  counts: {
    notesInBundle: number;
    chunksInBundle: number;
    factsInBundle: number;
    selectedNotes: number;
    selectedChunks: number;
    notesFromOriginalBytes: number;
    notesReconstructed: number;
    chunksNotLocated: number;
    chunksSpanInherited: number;
    eventsToAppend: number;
    multiValuedFactsDropped: number;
    factsSkipped: number;
  };
}

/** Destination fact streams already represented: `identityKey(subject)\0predicate\0scope`. */
export type ExistingFactStreams = Set<string>;

/**
 * Normalized stream identity — the SAME rule the lifecycle uses to decide a stream.
 *
 * `identityKey` applies the lifecycle's Unicode subject fold (NFC + case, explicit
 * aliases unified) so a stream the lifecycle considers one subject is skipped rather
 * than carried — carrying it either failed the whole import (older value, replay
 * monotonicity) or silently superseded the destination's owner-stated value (newer
 * value). The predicate is kept **exact**, matching `currentFact`'s `predicate = ?`:
 * lowercasing it here collapsed `Primary Goal` and `primary goal`, two streams the
 * lifecycle holds separately, so a real stream was silently dropped. The scope is
 * normalized exactly as the ledger/replay normalizes it, so raw variants cannot
 * collide later, and keyed by its slug: `scope:x`, `project:x` and `x` are one
 * stream, whose current value a write closes whatever spelling it was saved
 * with (scopeSpellings). Nothing here rewrites the bytes that are emitted or hashed.
 */
export function streamKey(subject: string, predicate: string, scope: string): string {
  const normalized = tryNormalizeScope(scope);
  const key = normalized ? scopeSpellings(normalized)[0] : scope.trim().toLowerCase();
  return `${identityKey(subject)}\u0000${predicate}\u0000${key}`;
}

export interface BuildPlanOptions {
  namespace: string;
  /** Source label; part of every carried event's identity and of its provenance. */
  label: string;
  /** Event `source` label recorded in the ledger. */
  eventSource: string;
  /** Streams the destination already holds, so no duplicate current fact is created. */
  existingStreams?: ExistingFactStreams;
  /**
   * The destination's own clock for this import, an ISO instant. A carried fact's time is a claim made by the bundle:
   * one later than this (beyond the write-clock tolerance) is replaced by it, so a bundle cannot install a current
   * fact from the future that rejects every later genuine write as a clock regression. Defaults to the clock at planning
   * time; a staged plan is applied later, so the bound only ever sits at or before the real write.
   */
  now?: string;
}

export function buildImportPlan(bundle: ImportBundle, options: BuildPlanOptions): ImportPlan {
  const existingStreams = options.existingStreams ?? new Set<string>();
  const destinationNow = options.now ?? new Date().toISOString();
  const notes: PlannedNote[] = [];
  const seenPaths = new Set<string>();
  let duplicateNotePath = 0;
  let emptyNoteBody = 0;
  let notesFromOriginalBytes = 0;

  for (const note of bundle.notes) {
    const relPath = destinationRelPath(options.namespace, note.relPath);
    if (seenPaths.has(relPath)) {
      duplicateNotePath += 1;
      continue;
    }
    seenPaths.add(relPath);
    const rendered = renderNoteMarkdown(note);
    if (!rendered.content.trim()) {
      emptyNoteBody += 1;
      continue;
    }
    if (rendered.fromOriginalBytes) notesFromOriginalBytes += 1;
    notes.push({
      relPath,
      content: rendered.content,
      contentHash: hashContent(rendered.content),
      fromOriginalBytes: rendered.fromOriginalBytes,
      chunkLines: rendered.chunkLines,
      chunksNotLocated: rendered.chunksNotLocated,
      chunksSpanInherited: rendered.chunksSpanInherited,
      note,
    });
  }

  const skipEvents = new Map<string, number>();
  const bump = (reason: string) => skipEvents.set(reason, (skipEvents.get(reason) ?? 0) + 1);

  const byStream = new Map<string, ImportFact[]>();
  for (const fact of bundle.facts) {
    const key = streamKey(fact.subject, fact.predicate, fact.scope);
    const list = byStream.get(key);
    if (list) list.push(fact);
    else byStream.set(key, [fact]);
  }

  let multiValuedFactsDropped = 0;
  const events: PlannedEvent[] = [];
  const emittedStreams = new Set<string>();

  for (const [key, facts] of byStream) {
    // The lifecycle layer holds at most ONE current value per (subject, predicate, scope).
    // The engine deliberately allows note-derived facts to be multi-valued, so a stream
    // with several distinct current values cannot become one current fact. Picking a
    // winner would misrepresent which value is current — and row order is not a
    // decision — so the whole stream is reported and dropped.
    const distinctObjects = new Set(facts.map(f => f.object));
    if (distinctObjects.size > 1) {
      multiValuedFactsDropped += facts.length;
      bump('multi-valued stream: the lifecycle holds one current value per subject+predicate');
      continue;
    }
    if (existingStreams.has(key)) {
      bump('destination already represents this subject+predicate');
      continue;
    }
    if (emittedStreams.has(key)) {
      bump('duplicate stream inside the bundle');
      continue;
    }
    const fact = facts[0];
    const validation = validateCarriedFact({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      scope: fact.scope,
      validFrom: fact.validFrom,
    });
    if (!validation.ok || !validation.scope || !validation.at) {
      bump(validation.reason ?? 'invalid fact');
      continue;
    }
    // Bound the bundle's claimed time by the destination's clock BEFORE the id is derived, so the planned event, the
    // stored valid_from and every read of it are bounded. Same rule and tolerance as every other content-derived clock.
    const at = clampSessionDate(validation.at, destinationNow) ?? destinationNow;
    // The event id is derived from every field replay compares, so a re-run against an
    // unchanged source re-appends nothing and a changed source yields a new event
    // instead of mutating one that replay already recorded.
    const id = deterministicEventId({
      label: options.label,
      subject: fact.subject,
      predicate: fact.predicate,
      scope: validation.scope,
      object: fact.object,
      at,
    });
    events.push({
      id,
      at,
      kind: 'store',
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      scope: validation.scope,
      source: importedLedgerSource(fact.ledgerSource ?? options.eventSource),
    });
    emittedStreams.add(key);
  }

  // RENOR_SECRET_GUARD (default OFF): a note or fact that looks like a secret is left out of the plan, with the
  // reason, so the dry run shows it and every other note is still imported. With the guard off none of this runs.
  let guardSkips: GuardSkips | null = null;
  if (secretGuardEnabled()) {
    const screened = leaveOutFlagged(notes, events);
    // In place and without spreading: a bundle can hold more notes than a call can take as arguments.
    notes.length = 0;
    for (const kept of screened.notes) notes.push(kept);
    events.length = 0;
    for (const kept of screened.events) events.push(kept);
    notesFromOriginalBytes = notes.filter(n => n.fromOriginalBytes).length;
    guardSkips = screened.skips;
  }

  // Deterministic append order, so two runs produce an identical ledger.
  events.sort((a, b) => streamKey(a.subject, a.predicate, a.scope).localeCompare(streamKey(b.subject, b.predicate, b.scope)));

  const skippedFacts = [...skipEvents.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    sourceLabel: bundle.sourceLabel,
    namespace: options.namespace,
    notes,
    events,
    skipped: { duplicateNotePath, emptyNoteBody, events: skippedFacts, ...(guardSkips ? { secretGuard: guardSkips } : {}) },
    counts: {
      notesInBundle: bundle.notes.length,
      chunksInBundle: bundle.stats.chunksSelected,
      factsInBundle: bundle.facts.length,
      selectedNotes: notes.length,
      selectedChunks: notes.reduce((sum, n) => sum + n.note.chunks.length, 0),
      notesFromOriginalBytes,
      notesReconstructed: notes.length - notesFromOriginalBytes,
      chunksNotLocated: notes.reduce((sum, n) => sum + n.chunksNotLocated, 0),
      chunksSpanInherited: notes.reduce((sum, n) => sum + n.chunksSpanInherited, 0),
      eventsToAppend: events.length,
      multiValuedFactsDropped,
      factsSkipped: skippedFacts.reduce((sum, s) => sum + s.count, 0),
    },
  };
}

/** The engine's own note change-detection hash, re-exported for callers. */
export function contentHash(content: string): string {
  return hashContent(content);
}
