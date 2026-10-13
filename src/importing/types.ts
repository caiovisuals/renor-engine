/** Portable memory bundle: the interface every import source must produce. */

/** One chunk of a note, exactly as the source store parsed it. */
export interface ImportChunk {
  headingPath: string;
  text: string;
  tokenCount: number;
  /**
   * The source's published line span for THIS chunk against the source's own bytes.
   * Carried verbatim: measured on a real index, the span is the chunker's section
   * boundary (larger than the trimmed text's line count for 14,954 of 22,774 chunks),
   * so it is the source's span, not something re-derivable from `text`.
   */
  startLine?: number;
  endLine?: number;
}

/** One entity the source derived from a note (part of the source's own parse). */
export interface ImportEntity {
  type: string;
  canonicalName: string;
  aliases: string[];
  confidence: number;
}

/** One note document. `chunks` is the source's own parse, never a re-parse. */
export interface ImportNote {
  /** Absolute path in the source store. Identity only; never written to the destination. */
  sourcePath: string;
  /** Path relative to the source root, used to map into the destination namespace. */
  relPath: string;
  title: string;
  kind: string | null;
  modifiedAt: string;
  frontmatter: Record<string, unknown>;
  chunks: ImportChunk[];
  /** Note-derived entities. Entities sourced from the lifecycle sentinel are never carried. */
  entities: ImportEntity[];
  /**
   * The note's original Markdown bytes, when the source's content tree is reachable.
   * Preferred over reconstruction: the source index's chunk line ranges are truthful
   * for these bytes, and carrying a document is not re-parsing it.
   */
  originalContent?: string;
}

/**
 * Where a carried fact came from.
 * - `ledger`: the source already holds it as a canonical ledger event; it is carried
 *   byte-identically (same `id` and `at`) so replay stays idempotent.
 * - `note`: the source derived it from a note. It is carried as a deterministic
 *   event so a re-run is a no-op, and its provenance is recorded in the event's
 *   `source` field rather than being passed off as owner-stated.
 */
export type ImportFactOrigin = 'ledger' | 'note';

export interface ImportFact {
  subject: string;
  predicate: string;
  object: string;
  scope: string;
  /** Canonical instant, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  validFrom: string;
  sourcePath: string;
  origin: ImportFactOrigin;
  /** Present for `ledger` facts: the source event id, carried verbatim. */
  eventId?: string;
  closedEvent?: string | null;
  ledgerSource?: string;
}

export interface ImportBundleStats {
  notesAvailable: number;
  notesSelected: number;
  notesFilteredOut: number;
  notesWithOriginalBytes: number;
  chunksSelected: number;
  factsAvailable: number;
  factsSelected: number;
}

export interface ImportBundle {
  format: string;
  sourceLabel: string;
  notes: ImportNote[];
  facts: ImportFact[];
  stats: ImportBundleStats;
  /**
   * Markdown files the source could not carry because a file or folder name on the way to them
   * is not valid UTF-8, written as a message writes them (bad bytes as `\xNN`), never as a
   * usable path. They count as neither available nor filtered out in `stats`. Only the Markdown
   * folder adapter sets this.
   */
  nonUtf8Names?: string[];
}

/** The bundle format this module reads and writes. */
export const BUNDLE_FORMAT = 'renor-memory-export/v1';
