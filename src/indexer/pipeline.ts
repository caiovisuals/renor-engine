import fs from 'fs/promises';
import path from 'path';
import { constants as fsConstants } from 'fs';
import { createHash } from 'crypto';
import { isUtf8 } from 'buffer';
import Database from 'better-sqlite3';
import { hashContent } from './hasher';
import { noteContentHash } from './dailyEntries';
import { parseNoteDetailed, wikilinkTargets, wikilinksSettled, type ParsedNote } from './parser';
import { chunkBodyFrom, chunkNoteCut, type Chunk, type LastSection, type NoteCut } from './chunker';
import { walkVault } from './walker';
import { embeddingSpace } from '../embeddings/space';
import type { EmbedOptions, EmbeddingIdentity } from '../embeddings/types';
import { withDailyFileLock } from '../memory/writer';
import { closeSync, openSync, readSync } from 'fs';
import { DAILY_NOTE_HEADER_KEY, isDailyNotePath, isEarlierHeaderText, isEngineDailyNote, isEngineHeaderDate } from '../memory/dailyNote';
import type { ExtractedFact } from '../extraction/factExtractor';
// HARMONIZED write path (merge of feat/c2-facts-writepath × origin/main):
// the fleet's extractors (typedFacts/eventExtractor/preferenceExtractor) are
// the CANDIDATE GENERATION layer (RENOR_TYPED_FACTS / RENOR_CHRONICLE /
// RENOR_PREFS, all default off); this branch's DecisionModel is the DECISION
// layer (capture-gate / dedupe / sensitivity-guardrail adjudication before
// any row is written). Single write path: decisions before writes.
import { captureNoteFacts, factsWritePathEnabled } from '../extraction/factsWritePath';
import type { DecisionModel } from '../extraction/decision-model';
import {
  adjudicateAndWriteRows,
  chunkForCandidate,
  type LaneCandidate,
} from '../extraction/writePathAdjudication';
import {
  contentDateFromFrontmatter,
  FACTS_EXTRACTION_VERSION,
  typedFactsEnabled,
} from '../extraction/typedFacts';
import {
  chronicleEnabled,
  EVENTS_EXTRACTION_VERSION,
} from '../extraction/eventExtractor';
import {
  PREFS_EXTRACTION_VERSION,
  prefsEnabled,
} from '../extraction/preferenceExtractor';
import {
  deleteStructuredRowsForSourceKind,
} from '../context/rowStore';
import { laneZeroYieldMarker, recordLaneRun } from './laneRuns';

/** Texts per request the embedding service takes at once (what Vertex's predict accepts). */
const EMBED_REQUEST_TEXTS = 32;

export interface IndexOptions {
  embeddingProvider?: { embed(texts: string[], options?: EmbedOptions): Promise<number[][]>; dimensions: number; readonly identity?: EmbeddingIdentity };
  /**
   * Interactive: an agent waits on this pass, so embedding a file takes at most this long per request of
   * EMBED_REQUEST_TEXTS texts, and a service that is slow or refusing leaves the file unfinished (its chunks stay, found
   * by keyword, and a later pass embeds them) instead of holding the file's lock until it answers. Unset: the provider
   * waits as long as its own retries take.
   */
  embedBudgetMs?: number;
  vectorIndex?: {
    upsert(id: number, embedding: number[]): void;
    delete(id: number): void;
    /**
     * Give chunk `toId` the stored vector of chunk `fromId`, byte for byte; false if `fromId` has
     * none. Optional: an index without it embeds every chunk of a changed file again.
     */
    copy?(fromId: number, toId: number): boolean;
    /** How many of these chunks have a stored vector. Optional: without it no chunk row is kept. */
    countStored?(chunkIds: number[]): number;
    /**
     * The embedding space the stored vectors are in (see embeddingSpace), set when the index first holds vectors,
     * and whether it holds any. Optional: without them nothing stored is kept or copied, since nothing says it is
     * in the space the provider writes.
     */
    space?(): string | null;
    setSpace?(space: string): void;
    hasVectors?(): boolean;
    /**
     * Whether the index is unfinished: a background job is writing the vector of every chunk that has none (see
     * VectorIndex.beginRebuild). Optional: without it a file embeds its own chunks, as it always did.
     */
    rebuilding?(): boolean;
  };
  chunkOptions?: { maxTokens?: number; overlapTokens?: number };
  factExtractor?: (noteTitle: string, noteBody: string) => Promise<ExtractedFact[]>;
  /** Pluggable extraction-time decision point (local rules default; Lane Jev adapter plugs in later). */
  decisionModel?: DecisionModel;

  /**
   * C2 typed numeric-fact extraction (RENOR_TYPED_FACTS, default off). Injected
   * so tests can stub the model; when unset but enabled, no extraction runs.
   */
  numericFactExtractor?: (noteTitle: string, noteBody: string) => Promise<
    import('../extraction/typedFacts').ExtractedNumericFact[]
  >;
  /**
   * C3 chronicle event extraction (RENOR_CHRONICLE, default off). Injected
   * so tests can stub the model; when unset but enabled, no extraction runs.
   */
  eventExtractor?: (noteTitle: string, noteBody: string) => Promise<
    import('../extraction/eventExtractor').ExtractedEvent[]
  >;
  /**
   * C4 standing-preference extraction (RENOR_PREFS, default off). Injected
   * so tests can stub the model; when unset but enabled, no extraction runs.
   */
  preferenceExtractor?: (noteTitle: string, noteBody: string) => Promise<
    import('../extraction/preferenceExtractor').ExtractedPreference[]
  >;
}

/**
 * The largest note the indexer reads. A note is held whole, parsed, serialised and chunked in memory; a flat front matter
 * costs about 28x its size in RSS (8 MB -> 487 MB, 64 MB -> 1.9 GB), and nothing else bounds a file on disk. A note over
 * it is reported, never read (IndexResult.skippedTooLarge); split it, or move it out of the memory folder.
 */
export const MAX_NOTE_BYTES = 8 * 1024 * 1024;

/** A note over MAX_NOTE_BYTES. indexFile throws it before reading a byte; indexVault reports it instead of counting an error. */
export class NoteTooLargeError extends Error {
  constructor(readonly filePath: string, readonly bytes: number) {
    super(`note is ${bytes} bytes; a note over ${MAX_NOTE_BYTES / (1024 * 1024)} MiB (${MAX_NOTE_BYTES} bytes) is not indexed. Split it or move it out of the memory folder.`);
    this.name = 'NoteTooLargeError';
  }
}

const FACT_PREDICATES = ['owner', 'status', 'updated', 'tags'] as const;

/** A front-matter value as fact text: a scalar as written, a mapping (or binary) as JSON. Never throws, never "[object Object]". */
const factText = (v: unknown): string => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : String(v));

/** The note is indexed anyway; say which front-matter value was not text, so a note that seems to ignore it can be explained. */
function warnFrontmatter(filePath: string, what: string): void {
  console.warn(`[index] ${filePath}: ${what}; the note is indexed without it`);
}

/** The note's `kind`: a string, else none. Anything else (a mapping, a list, a date, a number) is ignored with a warning. */
function noteKind(filePath: string, frontmatter: Record<string, unknown>): string | null {
  const kind = frontmatter.kind;
  if (typeof kind === 'string') return kind;
  if (kind !== undefined && kind !== null) warnFrontmatter(filePath, 'front matter "kind" is not text');
  return null;
}

/**
 * The extraction version each structured-row lane writes today. This is the
 * second half of the lane cache key, (source_hash, extraction_version), so it
 * is also the test for "is this preserved row still this lane's current row?".
 * One mapping, used by the in-transaction reattach and by the post-failure
 * restore, so a version bump cannot be applied in one place and missed in the
 * other. `row_kind` is CHECK-constrained to these three kinds.
 */
const LANE_EXTRACTION_VERSION: Record<string, string> = {
  fact: FACTS_EXTRACTION_VERSION,
  event: EVENTS_EXTRACTION_VERSION,
  preference: PREFS_EXTRACTION_VERSION,
};

function currentVersion(kind: string): string | undefined {
  return LANE_EXTRACTION_VERSION[kind];
}

/**
 * Whether the vectors this index holds are in the embedding space the provider writes, so a stored vector may
 * stand in for a fresh one. A new index takes the provider's space; vectors recorded in a different one are
 * never mixed with new ones (that fails the file, before anything changes, until the index is rebuilt); an
 * index that cannot say, or a provider with no identity, reuses nothing.
 */
function storedVectorsMatch(options: IndexOptions): boolean {
  const index = options.vectorIndex!;
  const wanted = embeddingSpace(options.embeddingProvider!);
  if (!wanted || !index.space || !index.setSpace || !index.hasVectors) return false;
  const stored = index.space();
  if (stored === wanted) return true;
  if (stored !== null) {
    throw new Error(
      `the index holds vectors from another embedding model (${stored}), not the configured one (${wanted}); `
      + 'rebuild the index rather than mix the two',
    );
  }
  if (index.hasVectors()) return false; // built before spaces were recorded: it cannot be vouched for
  index.setSpace(wanted);
  return true;
}

interface StoredChunk {
  id: number;
  heading_path: string;
  text: string;
  start_line: number;
  end_line: number;
  token_count: number;
  chunk_hash: string;
}

/** How many chunks, from the top of the note, are stored exactly as the note chunks now: same text, heading and place. */
function unchangedPrefix(stored: StoredChunk[], chunks: Chunk[]): number {
  let n = 0;
  while (n < stored.length && n < chunks.length) {
    const s = stored[n];
    const c = chunks[n];
    if (s.text !== c.text || s.heading_path !== c.headingPath || s.start_line !== c.startLine
        || s.end_line !== c.endLine || s.token_count !== c.tokenCount) break;
    n++;
  }
  return n;
}

/** The note's row: written before its chunks, as every pass does (the chunks reference it). */
function upsertNoteRow(
  db: Database.Database,
  filePath: string,
  row: { title: string; kind: string | null; noteHash: string; modifiedAt: string; frontmatterJson: string },
): void {
  db.prepare(`
    INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
    VALUES (@path, @title, @kind, @noteHash, @modifiedAt, @frontmatterJson)
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      kind = excluded.kind,
      note_hash = excluded.note_hash,
      modified_at = excluded.modified_at,
      frontmatter_json = excluded.frontmatter_json
  `).run({ path: filePath, ...row });
}

/** SQLite's LIKE and COLLATE NOCASE fold the ASCII letters and nothing else; so does this. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * The entity each wikilink points at, keyed by the link with its ASCII letters lowercased, in ONE pass over the entities.
 * A link names the entity whose note's path ends in `/<link>.md` or whose name is the link (ASCII case-insensitive), and
 * where several do, the one with the lowest id. That is what a query per link with `path LIKE '%/<link>.md' OR name = ?`
 * answered, but a leading wildcard cannot use an index, so that cost a scan of every note per distinct link: a 61 KB note
 * of 7,000 links took 22 s in a 2,000-note vault. A link nothing names has no entry.
 */
export function resolveWikilinks(db: Database.Database, links: string[]): Map<string, number> {
  const wanted = new Set(links.map(asciiLower));
  const found = new Map<string, number>();
  if (wanted.size === 0) return found;
  const rows = db.prepare(
    'SELECT e.id AS id, e.canonical_name AS name, n.path AS path FROM entities e JOIN notes n ON e.source_note = n.path ORDER BY e.id'
  ).iterate() as IterableIterator<{ id: number; name: string; path: string }>;
  for (const row of rows) {
    const claim = (key: string) => { if (wanted.has(key) && !found.has(key)) found.set(key, row.id); };
    claim(asciiLower(row.name));
    const lowerPath = asciiLower(row.path);
    if (lowerPath.endsWith('.md')) {
      const stem = lowerPath.slice(0, -3);
      for (let at = stem.indexOf('/'); at !== -1; at = stem.indexOf('/', at + 1)) claim(stem.slice(at + 1));
    }
    if (found.size === wanted.size) break;
  }
  return found;
}

/** A note's entity, frontmatter facts and wikilink relations, written again from its parse. Returns the entity's id. */
function rebuildNoteRows(
  db: Database.Database,
  filePath: string,
  note: Pick<ParsedNote, 'title' | 'frontmatter' | 'wikilinks'>,
  kind: string | null,
  engineWrote: boolean,
  now: string,
): number {
  // Frontmatter/LLM note facts use this index instant (and the default global scope). Keep the workspace's
  // observation even when a later pass replaces the rows after a backward clock step, or a note is retired.
  // This shares the note-row transaction, so a rolled-back pass cannot advance the read clock.
  db.prepare(`INSERT INTO note_index_clock (scope, observed_at) VALUES ('global', ?)
    ON CONFLICT(scope) DO UPDATE SET observed_at = MAX(note_index_clock.observed_at, excluded.observed_at)`)
    .run(now);
  // 10. Extract entities — delete old, insert new
  db.prepare('DELETE FROM entities WHERE source_note = ?').run(filePath);

  const rawAliases = note.frontmatter.aliases;
  const aliases = Array.isArray(rawAliases)
    ? rawAliases.filter((a): a is string => typeof a === 'string')
    : typeof rawAliases === 'string'
    ? [rawAliases]
    : [];
  if (rawAliases !== undefined && rawAliases !== null
      && (Array.isArray(rawAliases) ? aliases.length < rawAliases.length : typeof rawAliases !== 'string')) {
    warnFrontmatter(filePath, 'front matter "aliases" has a value that is not text');
  }

  const entityRow = db.prepare(`
    INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
    VALUES (@type, @canonicalName, @aliasesJson, @sourceNote, @confidence, @updatedAt)
    RETURNING id
  `).get({
    type: kind ?? 'note',
    canonicalName: note.title,
    aliasesJson: JSON.stringify(aliases),
    sourceNote: filePath,
    confidence: 1.0,
    updatedAt: now,
  }) as { id: number };

  // 11. Extract facts — delete old, insert new
  db.prepare('DELETE FROM facts WHERE source_path = ?').run(filePath);

  const insertFact = db.prepare(`
    INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at)
    VALUES (@subjectEntityId, @predicate, @objectText, @sourcePath, @confidence, @validFrom, @updatedAt)
  `);

  // The engine's own header in a daily note is bookkeeping, not something anyone said: the day the file is about, which
  // its name already says. Only a note the engine wrote has it (`engineWrote`, told from its front matter alone, not
  // its place, its name or its body), and only that value is dropped, never one a person put there (dailyNote.ts).
  for (const predicate of FACT_PREDICATES) {
    const value = note.frontmatter[predicate];
    if (value === undefined || value === null) continue;
    if (predicate === DAILY_NOTE_HEADER_KEY && engineWrote && isEngineHeaderDate(filePath, value)) continue;
    const objectText = Array.isArray(value) ? value.map(v => (v == null ? '' : factText(v))).join(', ') : factText(value);
    insertFact.run({
      subjectEntityId: entityRow.id,
      predicate,
      objectText,
      sourcePath: filePath,
      confidence: 1.0,
      validFrom: now,
      updatedAt: now,
    });
  }

  // 12. Save wikilink relations — delete old, insert new
  db.prepare('DELETE FROM relations WHERE source_note = ?').run(filePath);

  const insertRelation = db.prepare(`
    INSERT INTO relations (source_entity_id, relation, target_entity_id, source_note, confidence)
    VALUES (?, 'links_to', ?, ?, 1.0)
  `);

  const targets = resolveWikilinks(db, note.wikilinks);
  for (const wikilink of note.wikilinks) {
    const target = targets.get(asciiLower(wikilink));
    if (target !== undefined) insertRelation.run(entityRow.id, target, filePath);
  }
  return entityRow.id;
}

/** What a pass wrote that the vectors follow: see storeVectors. */
interface StoredPass {
  /** The note's chunks the pass kept or wrote, top to bottom; the first `kept` were kept with their vectors. */
  insertedChunks: Array<{ id: number; text: string }>;
  kept: number;
  /** The chunks the pass replaced: their vectors go. */
  oldChunkIds: number[];
  /** A written chunk -> a replaced chunk with the same text, whose vector it takes. */
  vectorSource: Map<number, number>;
  vectorsMatch: boolean;
  embedsHere: boolean;
  noteHash: string;
}

/**
 * After a pass's rows are committed: the written chunks take the vectors of replaced chunks with the same text, the
 * replaced chunks' vectors go, the rest are embedded, and only then is the note's hash committed (two-phase).
 */
async function storeVectors(
  db: Database.Database,
  filePath: string,
  options: IndexOptions,
  pass: StoredPass,
): Promise<void> {
  // A chunk whose text did not change keeps the vector it already has: copy it to the replacement
  // chunk before the old vectors go, and embed only the chunks with new text. An edited or
  // appended file then costs what changed, not what it holds (a ledger is one chunk per event).
  const { insertedChunks, kept, oldChunkIds, vectorSource, vectorsMatch, embedsHere, noteHash } = pass;
  const reused = new Set<number>();
  if (vectorsMatch && options.vectorIndex?.copy) {
    for (const [chunkId, fromId] of vectorSource) {
      if (options.vectorIndex.copy(fromId, chunkId)) reused.add(chunkId);
    }
  }

  if (options.vectorIndex) {
    for (const id of oldChunkIds) {
      options.vectorIndex.delete(id);
    }
  }

  // 9. Embed chunks if provider given (outside transaction — async)
  if (embedsHere && options.embeddingProvider && options.vectorIndex) {
    const { embeddingProvider, vectorIndex } = options;
    const toEmbed = insertedChunks.slice(kept).filter(c => !reused.has(c.id));
    const texts = toEmbed.map(c => c.text);
    if (texts.length > 0) {
      const embeddings = await embeddingProvider.embed(
        texts,
        options.embedBudgetMs === undefined ? undefined : { budgetMs: options.embedBudgetMs * Math.ceil(texts.length / EMBED_REQUEST_TEXTS) },
      );

      // Fix #3: Warn on embedding count mismatch instead of silently losing vectors
      if (embeddings.length !== texts.length) {
        console.error(
          `[pipeline] embedding count mismatch: expected ${texts.length}, got ${embeddings.length} for ${filePath}`
        );
      }

      for (let i = 0; i < toEmbed.length; i++) {
        if (embeddings[i]) {
          vectorIndex.upsert(toEmbed[i].id, embeddings[i]);
        }
      }
    }

    // Fix #2 (cont): Commit the real note_hash only after embedding succeeds
    db.prepare('UPDATE notes SET note_hash = ? WHERE path = ?').run(noteHash, filePath);
  }
}

/**
 * An append, indexed by what was appended. A note that grows only at its end (the ledger gains one event per fact a
 * save records; a person's running log) used to be read, parsed and cut in full on every pass, and every chunk it
 * already had was read back from the index to be compared, so a save cost what the note held. What a pass leaves
 * behind is kept per database and file (an AppendBase), and the next pass over the file, when the file is those
 * same bytes and more, indexes the note from its last section on: that section may change (text appended to it) and
 * sections may follow it, but nothing above it can, since its lines and the heading stack in force are the same.
 *
 * Exact, not trusting: the file is read and hashed whole, so any change to what was indexed sends the note through
 * the full pass; the index must still hold the note as the base was recorded (its hash, no structured row, as many
 * chunks before the last section), and the last section's stored chunks are read and compared as the full pass
 * compares them; and every kept chunk must still have its vector when the pass embeds, as the full pass requires.
 * The rows it writes are the ones the full pass writes for the same bytes. Everything else goes through the full
 * pass: a daily note (cut by entry; its stored hash also names its layout, so it never matches), a note whose title
 * comes from its file name or that has no heading section, a file that does not end with a line break or is not
 * valid UTF-8, an opening `[[` an append could close, other chunk options, any extraction lane, an index that cannot
 * report stored vectors, and a new chunk whose text one of the note's earlier chunks holds (whose vector the full
 * pass would copy).
 */
interface AppendBase {
  /** The bytes the pass indexed: how many, and their hash (the note's hash, since they are valid UTF-8). */
  bytes: number;
  noteHash: string;
  /** The chunk options the note was cut with. */
  chunking: string;
  /** The parse of the note: an append changes none of it but the wikilinks it adds. */
  title: string;
  kind: string | null;
  frontmatter: Record<string, unknown>;
  frontmatterJson: string;
  wikilinks: string[];
  /** Where the last section starts: the body line, the heading stack before it, and the line's byte offset in the file. */
  last: LastSection & { byte: number };
  /** The rows: the last section's first chunk, and how many chunks come before it (the head, whose rows a pass keeps). */
  tailFirstId: number;
  headCount: number;
  /** The texts of the chunks before the last section, by a prefix of their hash (a collision only means a full pass). */
  headHashes: Set<number>;
}

/** Per database: the last pass's AppendBase of each file, for at most this many files, the most recently indexed. */
const MAX_APPEND_BASES = 64;
const appendBases = new WeakMap<Database.Database, Map<string, AppendBase>>();

/** The file's base, removed: a pass that fails leaves none, and one that succeeds records its own. */
function takeAppendBase(db: Database.Database, filePath: string): AppendBase | undefined {
  const bases = appendBases.get(db);
  const base = bases?.get(filePath);
  bases?.delete(filePath);
  return base;
}

function recordAppendBase(db: Database.Database, filePath: string, base: AppendBase): void {
  let bases = appendBases.get(db);
  if (!bases) appendBases.set(db, bases = new Map());
  bases.delete(filePath);
  bases.set(filePath, base);
  if (bases.size > MAX_APPEND_BASES) bases.delete(bases.keys().next().value!);
}

const chunkingOf = (options: IndexOptions) =>
  `${options.chunkOptions?.maxTokens ?? 400}/${options.chunkOptions?.overlapTokens ?? 0}`;
const hashKey = (chunkHash: string) => parseInt(chunkHash.slice(0, 12), 16);

/** Whether any extraction lane would read the note: each reads all of it, so such a pass is a full one. */
function laneReadsNote(options: IndexOptions): boolean {
  return !!options.factExtractor
    || factsWritePathEnabled()
    || !!(options.numericFactExtractor && typedFactsEnabled())
    || !!(options.eventExtractor && chronicleEnabled())
    || !!(options.preferenceExtractor && prefsEnabled());
}

/** The base a full pass leaves, or null when an append to the note could not be indexed by its appended part. */
function appendBaseOf(
  filePath: string,
  raw: Buffer,
  content: string,
  detailed: { note: ParsedNote; rawBody: string; titleFromHeading: boolean },
  kind: string | null,
  cut: NoteCut,
  rows: { ids: number[]; hashes: string[] },
  noteHash: string,
  options: IndexOptions,
): AppendBase | null {
  if (isDailyNotePath(filePath) || raw.length === 0 || raw[raw.length - 1] !== 0x0a || !isUtf8(raw)) return null;
  if (!detailed.titleFromHeading || !cut.last || cut.lastFirst === undefined) return null;
  if (cut.lastFirst >= rows.ids.length) return null;
  if (!wikilinksSettled(detailed.rawBody)) return null;
  // Where the last section's first line starts in the file: the body is the text after the frontmatter, trimmed.
  const lines = detailed.note.body.split('\n');
  let at = content.length - detailed.rawBody.trimStart().length;
  for (let i = 0; i < cut.last.line; i++) at += lines[i].length + 1;
  if (!content.startsWith(lines[cut.last.line], at)) return null;
  return {
    bytes: raw.length,
    noteHash,
    chunking: chunkingOf(options),
    title: detailed.note.title,
    kind,
    frontmatter: detailed.note.frontmatter,
    frontmatterJson: JSON.stringify(detailed.note.frontmatter),
    wikilinks: detailed.note.wikilinks,
    last: { ...cut.last, byte: Buffer.byteLength(content.slice(0, at)) },
    tailFirstId: rows.ids[cut.lastFirst],
    headCount: cut.lastFirst,
    headHashes: new Set(rows.hashes.slice(0, cut.lastFirst).map(hashKey)),
  };
}

/**
 * Index `raw`, the file's bytes, by what was appended to the bytes `base` describes (see AppendBase). Returns false,
 * having changed nothing, when it cannot; the caller then indexes the file in full.
 */
async function indexAppend(
  db: Database.Database,
  filePath: string,
  raw: Buffer,
  options: IndexOptions,
  base: AppendBase,
): Promise<boolean> {
  if (raw.length <= base.bytes || chunkingOf(options) !== base.chunking || laneReadsNote(options)) return false;
  // The bytes that were indexed, unchanged, then valid text: hashed on the way to the note's new hash.
  const hash = createHash('sha256').update(raw.subarray(0, base.bytes));
  if (hash.copy().digest('hex') !== base.noteHash) return false;
  const appended = raw.subarray(base.bytes);
  if (!isUtf8(appended)) return false;
  const noteHash = hash.update(appended).digest('hex');

  // The note from its last section on: that section as it was indexed, then what was appended. The body is trimmed,
  // and this text starts with a line that is not blank (a heading, or the body's first line), so trimming its end
  // trims the body's.
  const kept = raw.toString('utf8', base.last.byte, base.bytes);
  const tail = kept + appended.toString('utf8');
  const lines = tail.trimEnd().split('\n');
  const cut = chunkBodyFrom(filePath, lines, base.last, options.chunkOptions);
  if (!cut.last || cut.lastFirst === undefined || cut.lastFirst >= cut.chunks.length) return false;
  const wikilinks = [...new Set([...base.wikilinks, ...wikilinkTargets(tail, kept.length)])];

  const stat = await fs.stat(filePath);
  const modifiedAt = stat.mtime.toISOString();
  const now = new Date().toISOString();
  const embeddingConfigured = !!(options.embeddingProvider && options.vectorIndex);
  const vectorsMatch = embeddingConfigured && storedVectorsMatch(options);
  const embedsHere = embeddingConfigured && !(vectorsMatch && options.vectorIndex!.rebuilding?.() === true);

  const write = db.transaction(() => {
    const existing = db.prepare('SELECT note_hash FROM notes WHERE path = ?').pluck().get(filePath) as string | undefined;
    if (existing !== base.noteHash) return null;
    if (db.prepare('SELECT 1 FROM structured_rows WHERE source_path = ? LIMIT 1').get(filePath)) return null;
    const oldTail = db.prepare(
      `SELECT id, heading_path, text, start_line, end_line, token_count, chunk_hash FROM chunks
       WHERE note_path = ? AND id >= ? ORDER BY id`
    ).all(filePath, base.tailFirstId) as StoredChunk[];
    const headIds = db.prepare('SELECT id FROM chunks WHERE note_path = ? AND id < ? ORDER BY id')
      .pluck().all(filePath, base.tailFirstId) as number[];
    if (headIds.length !== base.headCount) return null;
    // As a full pass does: the chunks from the top that are stored as they are now are kept (all of those before the
    // last section, whose lines did not change), and only if each kept chunk has its vector when the pass embeds.
    const keep = unchangedPrefix(oldTail, cut.chunks);
    const keptIds = [...headIds, ...oldTail.slice(0, keep).map(c => c.id)];
    if (keptIds.length > 0 && embedsHere
        && (!vectorsMatch || options.vectorIndex!.countStored?.(keptIds) !== keptIds.length)) return null;
    const added = cut.chunks.slice(keep).map(chunk => ({ chunk, chunkHash: hashContent(chunk.text) }));
    if (added.some(a => base.headHashes.has(hashKey(a.chunkHash)))) return null;

    upsertNoteRow(db, filePath, {
      title: base.title, kind: base.kind, noteHash: embedsHere ? '' : noteHash, modifiedAt, frontmatterJson: base.frontmatterJson,
    });
    if (keep < oldTail.length) db.prepare('DELETE FROM chunks WHERE note_path = ? AND id >= ?').run(filePath, oldTail[keep].id);
    const oldIdByHash = new Map<string, number>();
    for (const old of oldTail) if (!oldIdByHash.has(old.chunk_hash)) oldIdByHash.set(old.chunk_hash, old.id);
    const insertChunk = db.prepare(`
      INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
      VALUES (@notePath, @headingPath, @text, @startLine, @endLine, @tokenCount, @chunkHash)
      RETURNING id
    `);
    const insertedChunks: Array<{ id: number; text: string }> =
      oldTail.slice(0, keep).map((old, i) => ({ id: old.id, text: cut.chunks[i].text }));
    const vectorSource = new Map<number, number>();
    for (const { chunk, chunkHash } of added) {
      const row = insertChunk.get({
        notePath: chunk.notePath,
        headingPath: chunk.headingPath,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        tokenCount: chunk.tokenCount,
        chunkHash,
      }) as { id: number };
      insertedChunks.push({ id: row.id, text: chunk.text });
      const sameText = oldIdByHash.get(chunkHash);
      if (sameText !== undefined) vectorSource.set(row.id, sameText);
    }
    rebuildNoteRows(db, filePath, { title: base.title, frontmatter: base.frontmatter, wikilinks }, base.kind, false, now);
    return {
      insertedChunks,
      kept: keep,
      oldChunkIds: oldTail.slice(keep).map(old => old.id),
      vectorSource,
      chunkHashes: [...oldTail.slice(0, keep).map(old => old.chunk_hash), ...added.map(a => a.chunkHash)],
    };
  });
  const written = write();
  if (!written) return false;
  await storeVectors(db, filePath, options, { ...written, vectorsMatch, embedsHere, noteHash });

  // The next append starts from this note's new last section.
  if (raw[raw.length - 1] === 0x0a && wikilinksSettled(tail, kept.length)) {
    let at = 0;
    for (let i = base.last.line; i < cut.last.line; i++) at += lines[i - base.last.line].length + 1;
    for (const chunkHash of written.chunkHashes.slice(0, cut.lastFirst)) base.headHashes.add(hashKey(chunkHash));
    recordAppendBase(db, filePath, {
      ...base,
      bytes: raw.length,
      noteHash,
      wikilinks,
      last: { ...cut.last, byte: base.last.byte + Buffer.byteLength(tail.slice(0, at)) },
      tailFirstId: written.insertedChunks[cut.lastFirst].id,
      headCount: base.headCount + cut.lastFirst,
    });
  }
  return true;
}

async function readRegularFile(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath, { flag: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`refusing to index ${JSON.stringify(filePath)}: it is a symbolic link`);
    throw err;
  }
}

/**
 * Index one file. Runs under the same per-file lock every writer of that file takes, so an index
 * pass can never read a file, lose the race to a rewrite (memory retirement), and then commit the
 * stale text over the newer index.
 */
export function indexFile(
  db: Database.Database,
  filePath: string,
  options: IndexOptions = {}
): Promise<void> {
  return withDailyFileLock(filePath, () => indexFileUnlocked(db, filePath, options));
}

async function indexFileUnlocked(
  db: Database.Database,
  filePath: string,
  options: IndexOptions = {}
): Promise<void> {
  // 0. A note over the cap is not read (a read allocates the file, and parsing it a multiple of that)
  const { size } = await fs.stat(filePath);
  if (size > MAX_NOTE_BYTES) throw new NoteTooLargeError(filePath, size);

  // 1. Read file content. Never through a symbolic link: the walker does not list one, and a caller that names one (the
  // watcher is told of a link to a file as the file) must not pull a file from outside the vault into recall.
  const raw = await readRegularFile(filePath);
  // A note this process indexed that has only been appended to since is indexed by what was appended (see
  // indexAppend); anything else is read and indexed in full, below.
  const base = takeAppendBase(db, filePath);
  if (base && await indexAppend(db, filePath, raw, options, base)) return;
  const content = raw.toString('utf8');

  // 2. Hash content (a daily note's hash also names the layout its chunks are cut in, see dailyEntries.ts)
  const noteHash = noteContentHash(filePath, content);

  // 3. Check if unchanged
  const existing = db.prepare('SELECT note_hash FROM notes WHERE path = ?').get(filePath) as { note_hash: string } | undefined;
  const noteUnchanged = !!(existing && existing.note_hash === noteHash);
  if (noteUnchanged && base?.noteHash === noteHash) recordAppendBase(db, filePath, base); // it still describes the note
  if (noteUnchanged) {
    // The facts of an unchanged note are not rebuilt below, so a row an earlier build made of the engine's own header
    // would stay. Remove it here: one statement for a daily note, no chunk or extractor involved.
    removeDailyHeaderFacts(db, filePath, content);
    // C2: unchanged content skips extraction ONLY when current-version rows
    // already exist (ADR §4.2 — the cache key is (source_hash,
    // extraction_version)). An extraction_version change invalidates the cache
    // and falls through to re-extract, still with zero model calls until the
    // (re-)extraction itself.
    if (
      (options.numericFactExtractor && typedFactsEnabled()) ||
      (options.eventExtractor && chronicleEnabled()) ||
      (options.preferenceExtractor && prefsEnabled())
    ) {
      // The cache key is per lane: (source_hash, extraction_version). Skip
      // only when EVERY enabled lane is already done for these bytes — an
      // enabled lane without rows (first run, version bump) falls through.
      // "Done" is either half of the key: a current row for this hash, or a
      // completed zero-yield run (#189, lane_runs — a lane that produced
      // nothing has no row to record it).
      const factsEnabled = !!(options.numericFactExtractor && typedFactsEnabled());
      const eventsEnabled = !!(options.eventExtractor && chronicleEnabled());
      const prefsEnabledLane = !!(options.preferenceExtractor && prefsEnabled());
      const haveCurrentVersionRows = !factsEnabled || !!db.prepare(
        `SELECT id FROM structured_rows
         WHERE source_path = ? AND row_kind = 'fact' AND extraction_version = ? AND source_hash = ? AND valid_to IS NULL LIMIT 1`,
      ).get(filePath, FACTS_EXTRACTION_VERSION, noteHash) || !!laneZeroYieldMarker(
        db, filePath, 'fact', noteHash, FACTS_EXTRACTION_VERSION,
      );
      const haveCurrentEventRows = !eventsEnabled || !!db.prepare(
        `SELECT id FROM structured_rows
         WHERE source_path = ? AND row_kind = 'event' AND extraction_version = ? AND source_hash = ? AND valid_to IS NULL LIMIT 1`,
      ).get(filePath, EVENTS_EXTRACTION_VERSION, noteHash) || !!laneZeroYieldMarker(
        db, filePath, 'event', noteHash, EVENTS_EXTRACTION_VERSION,
      );
      const haveCurrentPrefRows = !prefsEnabledLane || !!db.prepare(
        `SELECT id FROM structured_rows
         WHERE source_path = ? AND row_kind = 'preference' AND extraction_version = ? AND source_hash = ? AND valid_to IS NULL LIMIT 1`,
      ).get(filePath, PREFS_EXTRACTION_VERSION, noteHash) || !!laneZeroYieldMarker(
        db, filePath, 'preference', noteHash, PREFS_EXTRACTION_VERSION,
      );
      if (haveCurrentVersionRows && haveCurrentEventRows && haveCurrentPrefRows) {
        return; // unchanged content: zero model calls
      }
      // else: a lane lacks current rows → fall through, stale rows deleted below.
    } else {
      return; // unchanged — skip
    }
  }

  // 4. Parse note
  const detailed = parseNoteDetailed(filePath, content);
  const parsed = detailed.note;

  // 5. Get mtime
  const stat = await fs.stat(filePath);
  const modifiedAt = stat.mtime.toISOString();

  const now = new Date().toISOString();
  const kind = noteKind(filePath, parsed.frontmatter);

  // HARMONIZATION: lane ownership — when the fleet's typed-facts lane is armed
  // (extractor + RENOR_TYPED_FACTS), it is THE fact-lane candidate generator;
  // this branch's local-rules capture lane (RENOR_FACTS_WRITE_PATH) stands
  // down for that note so the same note is never fact-extracted twice (two
  // generators would double-write the same identities under two extraction
  // versions). With only RENOR_FACTS_WRITE_PATH on, behavior is unchanged
  // from this branch (local rules + DecisionModel seam).
  const typedFactsLaneArmed = !!(
    options.numericFactExtractor && typedFactsEnabled()
  );

  const embeddingConfigured = !!(options.embeddingProvider && options.vectorIndex);
  // Stored vectors may be kept or copied only if they are in the space this provider writes.
  const vectorsMatch = embeddingConfigured && storedVectorsMatch(options);
  // While the index is unfinished in this provider's space, the background job that completes it embeds every chunk
  // that has no vector, this file's included. The file's chunks are then written without vectors and left to it, so
  // no chunk is embedded twice and a save embeds nothing it did not change (a ledger appended to keeps its earlier
  // events as they are). Decided in the same synchronous step as the write below, so the job cannot have finished
  // in between: it ends only when no chunk lacks a vector.
  const embedsHere = embeddingConfigured && !(vectorsMatch && options.vectorIndex!.rebuilding?.() === true);
  // Fix #2: Use two-phase note_hash commit. If this file embeds its chunks, store ''
  // so that a failed embed() causes the file to be re-processed on the next run.
  // Store the real hash only after embeddings succeed (or immediately if nothing is embedded here).
  const transactionHash = embedsHere ? '' : noteHash;

  // 6-12. Wrap all DB mutations in a transaction.
  // Fix #1: Query old chunk IDs inside the transaction so they are only deleted
  // from the vector index AFTER the transaction commits successfully.
  const upsertAll = db.transaction(() => {
    // The stored chunks, top to bottom (a note's chunk ids ascend with position). The ones that
    // are replaced have their vectors deleted after commit.
    const oldChunks = db.prepare(
      'SELECT id, heading_path, text, start_line, end_line, token_count, chunk_hash FROM chunks WHERE note_path = ? ORDER BY id'
    ).all(filePath) as StoredChunk[];
    // The old chunk holding each text: a chunk whose text is unchanged keeps its vector.
    const oldIdByHash = new Map<string, number>();
    for (const old of oldChunks) if (!oldIdByHash.has(old.chunk_hash)) oldIdByHash.set(old.chunk_hash, old.id);
    const cut = chunkNoteCut(parsed, options.chunkOptions);
    const chunks = cut.chunks;

    // 6. Upsert note row
    upsertNoteRow(db, filePath, {
      title: parsed.title, kind, noteHash: transactionHash, modifiedAt, frontmatterJson: JSON.stringify(parsed.frontmatter),
    });

    // 7. Delete old chunks. structured_rows.source_chunk_id cascades, and
    // the per-lane cache check happens after this rewrite. Copy current rows
    // out first and reattach them to the replacement chunk, or a current lane
    // looks stale and is extracted again.
    const preservedStructured = db.prepare(
      `SELECT r.row_kind, r.source_hash, r.scope, r.extraction_version, r.valid_from, r.valid_to,
              r.payload_json, r.dedupe_key, r.confirm_count, r.created_at, c.text AS source_text
       FROM structured_rows r
       LEFT JOIN chunks c ON c.id = r.source_chunk_id
       WHERE r.source_path = ?`,
    ).all(filePath) as Array<Record<string, unknown>>;
    const preservedByKind = new Map<string, Array<Record<string, unknown>>>();
    for (const saved of preservedStructured) {
      const kind = String(saved.row_kind);
      const bucket = preservedByKind.get(kind) ?? [];
      bucket.push(saved);
      preservedByKind.set(kind, bucket);
    }

    // The chunks from the top of an edited note that are already stored exactly as they are now
    // keep their rows, search entries and vectors; only the rest is replaced (a ledger appended to
    // replaces its last event and adds the new one). The whole note is replaced instead when the
    // bytes are unchanged (a lane re-run), when the last pass over it did not finish (an empty
    // hash), when structured rows hang off its chunks, or when a stored chunk lacks its vector,
    // so a full pass heals it, as it always did.
    let keep = 0;
    if (existing && !noteUnchanged && existing.note_hash !== '' && preservedStructured.length === 0) {
      keep = unchangedPrefix(oldChunks, chunks);
      if (keep > 0 && embedsHere
          && (!vectorsMatch || options.vectorIndex!.countStored?.(oldChunks.slice(0, keep).map(c => c.id)) !== keep)) {
        keep = 0;
      }
    }
    if (keep === 0) db.prepare('DELETE FROM chunks WHERE note_path = ?').run(filePath);
    else db.prepare('DELETE FROM chunks WHERE note_path = ? AND id > ?').run(filePath, oldChunks[keep - 1].id);

    // 8. Insert the chunks that are not kept, collecting inserted IDs
    const insertChunk = db.prepare(`
      INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
      VALUES (@notePath, @headingPath, @text, @startLine, @endLine, @tokenCount, @chunkHash)
      RETURNING id
    `);

    const insertedChunks: Array<{ id: number; text: string }> =
      oldChunks.slice(0, keep).map((old, i) => ({ id: old.id, text: chunks[i].text }));
    const chunkHashes = oldChunks.slice(0, keep).map(old => old.chunk_hash); // of every chunk, in order
    const vectorSource = new Map<number, number>(); // new chunk id -> old chunk id with the same text
    for (const chunk of chunks.slice(keep)) {
      const chunkHash = hashContent(chunk.text);
      chunkHashes.push(chunkHash);
      const row = insertChunk.get({
        notePath: chunk.notePath,
        headingPath: chunk.headingPath,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        tokenCount: chunk.tokenCount,
        chunkHash,
      }) as { id: number };
      insertedChunks.push({ id: row.id, text: chunk.text });
      const sameText = oldIdByHash.get(chunkHash);
      if (sameText !== undefined) vectorSource.set(row.id, sameText);
    }

    // Reattach rows copied out before the chunk delete. A lane whose version
    // and hash are still current keeps its row; a stale lane stays deleted so
    // only that lane re-extracts. The row keeps the replacement chunk that
    // still contains its source text. Chunk 0 is only the fallback when that
    // text is gone; it is not the provenance of every preserved row.
    if (preservedStructured.length > 0 && insertedChunks.length > 0) {
      const reattach = db.prepare(
        `INSERT INTO structured_rows
           (row_kind, source_path, source_hash, source_chunk_id, scope, extraction_version,
            valid_from, valid_to, payload_json, dedupe_key, confirm_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const saved of preservedStructured) {
        const kind = saved.row_kind as string;
        const version = saved.extraction_version as string;
        const hash = saved.source_hash as string;
        const current = saved.valid_to == null
          && version === currentVersion(kind)
          && hash === noteHash;
        if (!current) continue;
        const sourceText = typeof saved.source_text === 'string' ? saved.source_text : '';
        const attributed = sourceText
          ? chunkForCandidate(insertedChunks, { statement: sourceText })
          : null;
        const chunkId = attributed?.chunkId ?? insertedChunks[0].id;
        reattach.run(
          kind,
          filePath,
          hash,
          chunkId,
          saved.scope,
          version,
          saved.valid_from,
          saved.valid_to,
          saved.payload_json,
          saved.dedupe_key,
          saved.confirm_count,
          saved.created_at,
        );
      }
    }

    // 10-12. Entities, frontmatter facts and wikilink relations: delete old, insert new
    const entityId = rebuildNoteRows(db, filePath, parsed, kind, isEngineDailyNote(filePath, content), now);

    return {
      insertedChunks,
      kept: keep,
      oldChunkIds: oldChunks.slice(keep).map(old => old.id),
      vectorSource,
      entityId,
      preservedByKind,
      cut,
      chunkHashes,
    };
  });

  // Fix #1 (cont): Delete old vectors only after transaction commits successfully
  const { insertedChunks, kept, oldChunkIds, vectorSource, entityId, preservedByKind, cut, chunkHashes } = upsertAll() as {
    insertedChunks: Array<{ id: number; text: string }>;
    kept: number;
    oldChunkIds: number[];
    vectorSource: Map<number, number>;
    entityId: number;
    preservedByKind: Map<string, Array<Record<string, unknown>>>;
    cut: NoteCut;
    chunkHashes: string[];
  };

  // These post-failure helpers and the in-transaction reattach above must
  // agree on one thing: a preserved row only counts as that lane's current row
  // when its extraction_version matches the version that lane writes today
  // (currentVersion), which is the same key the lane cache-skip below uses.
  function preservedLaneMatches(kind: string): boolean {
    const savedRows = preservedByKind.get(kind) ?? [];
    return savedRows.some(saved => (
      saved.valid_to == null
      && saved.source_hash === noteHash
      && saved.extraction_version === currentVersion(kind)
    ));
  }

  function restorePreservedLane(kind: string): void {
    const savedRows = (preservedByKind.get(kind) ?? []).filter(saved => (
      saved.valid_to == null
      && saved.source_hash === noteHash
      && saved.extraction_version === currentVersion(kind)
    ));
    if (savedRows.length === 0 || insertedChunks.length === 0) return;
    const restore = db.prepare(
      `INSERT INTO structured_rows
         (row_kind, source_path, source_hash, source_chunk_id, scope, extraction_version,
          valid_from, valid_to, payload_json, dedupe_key, confirm_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const saved of savedRows) {
      const sourceText = typeof saved.source_text === 'string' ? saved.source_text : '';
      const attributed = sourceText
        ? chunkForCandidate(insertedChunks, { statement: sourceText })
        : null;
      restore.run(
        kind,
        filePath,
        saved.source_hash,
        attributed?.chunkId ?? insertedChunks[0].id,
        saved.scope,
        saved.extraction_version,
        saved.valid_from,
        saved.valid_to,
        saved.payload_json,
        saved.dedupe_key,
        saved.confirm_count,
        saved.created_at,
      );
    }
  }

  await storeVectors(db, filePath, options, { insertedChunks, kept, oldChunkIds, vectorSource, vectorsMatch, embedsHere, noteHash });

  // 11b. LLM fact extraction — runs outside transaction, after embeddings (async/network).
  // Fix #5: On extraction failure, reset note_hash to '' so the next unchanged-file
  // indexing pass re-processes this note and retries extraction. Otherwise the real
  // hash committed above (embedding path) or in the transaction marks the note as
  // fully current while its LLM facts are missing/stale — and the transaction has
  // already deleted the prior facts for this source, making the loss sticky.
  if (options.factExtractor) {
    try {
      const llmFacts = await options.factExtractor(parsed.title, parsed.body);
      if (llmFacts.length > 0) {
        const insertLlmFact = db.prepare(`
          INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const fact of llmFacts) {
          insertLlmFact.run(entityId, fact.predicate, `${fact.subject}: ${fact.object}`, filePath, fact.confidence, now, now);
        }
      }
    } catch (err) {
      console.error(`[pipeline] LLM extraction failed for ${filePath}:`, (err as Error).message);
      // #188: reset the hash so the next pass retries (Fix #5), AND rethrow.
      // Swallowing it here left `indexVault` counting the note as INDEXED, so
      // `index` reported 0 errors and exited 0 with this note's facts missing —
      // the blanket catch #188 is about. The structured lanes below already
      // rethrow; this lane now fails the same way, so a real failure reaches the
      // process exit status. Every other note still indexes.
      db.prepare("UPDATE notes SET note_hash = '' WHERE path = ?").run(filePath);
      throw err;
    }
  }

  // C2 facts write-path (flag-gated, default OFF): save-time typed fact
  // capture into the structured-row store through the real index pipeline.
  // Flag off = zero decision calls, zero new writes, byte-identical shipped
  // behavior. The bitemporal model is the rowStore's identity-keyed
  // supersession (the markdown ledger stays `_mcp_`-lifecycle-only per
  // inventory-facts). Fix #5 pattern: a capture failure resets note_hash so
  // the next pass retries — failed capture never marks a note current.
  // HARMONIZATION: stands down when the fleet's typed-facts lane is armed
  // (single fact-lane candidate generator — see lane ownership above).
  if (!typedFactsLaneArmed && factsWritePathEnabled()) {
    try {
      await captureNoteFacts(db, {
        notePath: filePath,
        noteTitle: parsed.title,
        frontmatter: parsed.frontmatter,
        sourceHash: noteHash,
        chunks: insertedChunks,
      }, options.decisionModel);
    } catch (err) {
      console.error(`[pipeline] facts write-path capture failed for ${filePath}:`, (err as Error).message);
      // Same #188 contract as the legacy lane above: reset the hash so the next
      // pass retries, then rethrow so the failure is counted and reaches the
      // exit status instead of being hidden by a blanket catch.
      db.prepare("UPDATE notes SET note_hash = '' WHERE path = ?").run(filePath);
      throw err;
    }
  }

  // 11c. C2 typed numeric facts → structured_rows (RENOR_TYPED_FACTS, default
  // off; ADR-0003 §4 provenance contract + §4.2 cache invalidation). The
  // (source_hash, extraction_version) skip happens BEFORE any model call:
  // unchanged content is either already covered by current-version rows or by
  // a completed zero-yield run (lane_runs, #189) and costs zero extractor calls.
  // Edit path: stale rows for this source are deleted and re-extracted. On
  // extractor-parse-error the note hash resets so the next pass retries;
  // parse failures are never cached and never silently [].
  // HARMONIZATION: candidates flow through the DecisionModel seam
  // (adjudicateAndWriteRows) BEFORE any row is written — capture-gate /
  // sensitivity-guardrail (a `sensitive` decision blocks the candidate) and
  // dedupe adjudication with the confirm-count + v11 unique-index semantics.
  if (options.numericFactExtractor && typedFactsEnabled()) {
    // One predicate, both halves of the lane cache: a current row for these
    // bytes, OR a completed zero-yield run for them (#189). A lane that
    // produced nothing must be recognised BEFORE any extraction work starts,
    // or it is re-extracted on every unchanged pass forever.
    const structured = db.prepare(
      `SELECT id FROM structured_rows
       WHERE source_path = ? AND row_kind = 'fact' AND extraction_version = ? AND source_hash = ? AND valid_to IS NULL LIMIT 1`,
    ).get(filePath, FACTS_EXTRACTION_VERSION, noteHash) as { id: number } | undefined
      ?? laneZeroYieldMarker(db, filePath, 'fact', noteHash, FACTS_EXTRACTION_VERSION);
    if (!structured) {
      // This lane is stale. Re-extract only fact rows; a current fact lane
      // falls through so events and preferences still run. The previous rows
      // stay until the new extraction returns, so an extractor that yields
      // nothing does not empty the lane. An extractor that THROWS does: a
      // stale-version lane is left empty on purpose (see the catch below).
      try {
        const extracted = await options.numericFactExtractor(parsed.title, parsed.body);
        deleteStructuredRowsForSourceKind(db, filePath, 'fact');
        const validFrom = contentDateFromFrontmatter(parsed.frontmatter);
        const firstChunkId = (db.prepare(
          'SELECT id FROM chunks WHERE note_path = ? ORDER BY id LIMIT 1',
        ).get(filePath) as { id: number } | undefined)?.id;
        const candidates: LaneCandidate[] = extracted.map((f) => {
          const attributed = chunkForCandidate(insertedChunks, f);
          return {
            payload: { value: f.value, unit: f.unit, verb: f.verb, object: f.object, event: f.event },
            sourceChunkId: attributed?.chunkId ?? firstChunkId ?? 1,
            sourceText: attributed?.text ?? `${f.value} ${f.object}`.trim(),
          };
        });
        const outcome = await adjudicateAndWriteRows(db, {
          rowKind: 'fact',
          extractionVersion: FACTS_EXTRACTION_VERSION,
          notePath: filePath,
          sourceHash: noteHash,
          validFrom,
          candidates,
        }, options.decisionModel);
        // #189: the zero-yield checkpoint. This lane used to be called again
        // on every unchanged pass because a zero yield leaves no row to mark it
        // current; the completed run is recorded here instead — after the
        // extractor and the writes both succeeded, so the throw path below
        // stays uncached (it resets the note hash and must retry). What is
        // recorded is what THIS run's writes returned — a fact of the run, not a
        // count re-read from structured_rows, which a concurrent writer could
        // tear (review B1) — so a zero is exactly "left nothing current".
        recordLaneRun(db, filePath, 'fact', noteHash, FACTS_EXTRACTION_VERSION, outcome.rowsWritten);
      } catch (err) {
        console.error(
          `[pipeline] typed-fact extraction failed for ${filePath}:`,
          (err as Error).message,
        );
        // Never cached, never silent []: reset the note hash so the next pass
        // retries, then rethrow the explicit error (extractor-parse-error or
        // otherwise) — a note whose extraction failed is never reported current.
        // A stale-version row was not reattached and is deliberately NOT put
        // back: a bumped extraction_version invalidates the lane, so its old
        // payload must never be served as current. The lane stays empty until
        // the retry succeeds, which the reset hash guarantees it will attempt.
        db.prepare("UPDATE notes SET note_hash = '' WHERE path = ?").run(filePath);
        // An edited note must not keep the previous assertion as current
        // against the new text. Restore only when the preserved row is still
        // this lane's current row for these bytes, including a retry after an
        // earlier failure cleared the note hash.
        if (noteUnchanged || preservedLaneMatches('fact')) restorePreservedLane('fact');
        throw err;
      }
    }
  }

  // 11d. C3 chronicle events → structured_rows (RENOR_CHRONICLE, default off;
  // ADR-0003 §4 event-lane payload + §4.1 identity-keyed supersession via the
  // shared rowStore insert). The (source_hash, extraction_version) skip happens
  // BEFORE any model call: unchanged content is either already covered by
  // current-version event rows or by a completed zero-yield run (lane_runs,
  // #189) and costs zero extractor calls. Edit path: stale rows for this source are
  // deleted and re-extracted. `when` stays the user's own wording inside the
  // payload; the row's valid_from comes only from the note's frontmatter date
  // (NULL = unknown, never resolved/invented from the relative `when`). On
  // extractor-parse-error the note hash resets so the next pass retries;
  // parse failures are never cached and never silently [].
  // HARMONIZATION: candidates flow through the DecisionModel seam
  // (adjudicateAndWriteRows) BEFORE any row is written — capture-gate /
  // sensitivity-guardrail (a `sensitive` decision blocks the candidate) and
  // dedupe adjudication; the write keeps the fleet's identity-keyed
  // supersession semantics (newer dated restatement supersedes; NULL dates
  // never supersede).
  if (options.eventExtractor && chronicleEnabled()) {
    const currentEvents = db.prepare(
      `SELECT id FROM structured_rows
       WHERE source_path = ? AND row_kind = 'event' AND extraction_version = ? AND source_hash = ? AND valid_to IS NULL LIMIT 1`,
    ).get(filePath, EVENTS_EXTRACTION_VERSION, noteHash) as { id: number } | undefined
      ?? laneZeroYieldMarker(db, filePath, 'event', noteHash, EVENTS_EXTRACTION_VERSION);
    if (!currentEvents) {
      // This lane is stale. Re-extract only event rows. The previous rows
      // stay until the new extraction returns.
      try {
        const extracted = await options.eventExtractor(parsed.title, parsed.body);
        deleteStructuredRowsForSourceKind(db, filePath, 'event');
        const validFrom = contentDateFromFrontmatter(parsed.frontmatter);
        const firstChunkId = (db.prepare(
          'SELECT id FROM chunks WHERE note_path = ? ORDER BY id LIMIT 1',
        ).get(filePath) as { id: number } | undefined)?.id;
        const candidates: LaneCandidate[] = extracted.map((e) => {
          const attributed = chunkForCandidate(insertedChunks, e);
          return {
            payload: { when: e.when, event: e.event, entities: e.entities },
            sourceChunkId: attributed?.chunkId ?? firstChunkId ?? 1,
            sourceText: attributed?.text ?? `${e.when} ${e.event}`.trim(),
          };
        });
        const outcome = await adjudicateAndWriteRows(db, {
          rowKind: 'event',
          extractionVersion: EVENTS_EXTRACTION_VERSION,
          notePath: filePath,
          sourceHash: noteHash,
          validFrom,
          candidates,
        }, options.decisionModel);
        // Zero-yield events: same checkpoint as the fact lane (#189).
        recordLaneRun(db, filePath, 'event', noteHash, EVENTS_EXTRACTION_VERSION, outcome.rowsWritten);
      } catch (err) {
        console.error(
          `[pipeline] event extraction failed for ${filePath}:`,
          (err as Error).message,
        );
        // Never cached, never silent []: reset the note hash so the next pass
        // retries, then rethrow the explicit error (extractor-parse-error or
        // otherwise) — a note whose extraction failed is never reported current.
        db.prepare("UPDATE notes SET note_hash = '' WHERE path = ?").run(filePath);
        if (noteUnchanged || preservedLaneMatches('event')) restorePreservedLane('event');
        throw err;
      }
    }
  }

  // 11e. C4 standing preferences → structured_rows (RENOR_PREFS, default off;
  // ADR-0003 §4 preference-lane payload + §4.1 identity-keyed supersession via
  // the shared rowStore insert — contradiction on edit supersedes, never
  // co-current, only via (row_kind, scope, norm(statement)) identity). The
  // (source_hash, extraction_version) skip happens BEFORE any model call:
  // unchanged content is either already covered by current-version pref rows
  // or by a completed zero-yield run (lane_runs, #189) and costs zero
  // extractor calls. `kind` is an unvalidated render-only enum, never in the
  // dedupe key. One-off past-tense statements are dropped by the extractor's
  // structural guard. On extractor-parse-error the note hash resets so the
  // next pass retries; parse failures are never cached and never silently [].
  // HARMONIZATION: candidates flow through the DecisionModel seam
  // (adjudicateAndWriteRows) BEFORE any row is written — capture-gate /
  // sensitivity-guardrail (a `sensitive` decision blocks the candidate) and
  // dedupe adjudication (norm(statement) identity); the write keeps the
  // fleet's identity-keyed supersession semantics (contradiction on edit →
  // same-identity newer restatement supersedes, never co-current).
  if (options.preferenceExtractor && prefsEnabled()) {
    const currentPrefs = db.prepare(
      `SELECT id FROM structured_rows
       WHERE source_path = ? AND row_kind = 'preference' AND extraction_version = ? AND source_hash = ? AND valid_to IS NULL LIMIT 1`,
    ).get(filePath, PREFS_EXTRACTION_VERSION, noteHash) as { id: number } | undefined
      ?? laneZeroYieldMarker(db, filePath, 'preference', noteHash, PREFS_EXTRACTION_VERSION);
    if (!currentPrefs) {
      // This lane is stale. Re-extract only preference rows. The previous
      // rows stay until the new extraction returns.
      try {
        const extracted = await options.preferenceExtractor(parsed.title, parsed.body);
        deleteStructuredRowsForSourceKind(db, filePath, 'preference');
        const validFrom = contentDateFromFrontmatter(parsed.frontmatter);
        const firstChunkId = (db.prepare(
          'SELECT id FROM chunks WHERE note_path = ? ORDER BY id LIMIT 1',
        ).get(filePath) as { id: number } | undefined)?.id;
        const candidates: LaneCandidate[] = extracted.map((p) => {
          const attributed = chunkForCandidate(insertedChunks, p);
          return {
            payload: { statement: p.statement, kind: p.kind },
            sourceChunkId: attributed?.chunkId ?? firstChunkId ?? 1,
            sourceText: attributed?.text ?? p.statement,
          };
        });
        const outcome = await adjudicateAndWriteRows(db, {
          rowKind: 'preference',
          extractionVersion: PREFS_EXTRACTION_VERSION,
          notePath: filePath,
          sourceHash: noteHash,
          validFrom,
          candidates,
        }, options.decisionModel);
        // Zero-yield preferences: same checkpoint as the fact lane (#189).
        recordLaneRun(db, filePath, 'preference', noteHash, PREFS_EXTRACTION_VERSION, outcome.rowsWritten);
      } catch (err) {
        console.error(
          `[pipeline] preference extraction failed for ${filePath}:`,
          (err as Error).message,
        );
        // Never cached, never silent []: reset the note hash so the next pass
        // retries, then rethrow the explicit error (extractor-parse-error or
        // otherwise) — a note whose extraction failed is never reported current.
        db.prepare("UPDATE notes SET note_hash = '' WHERE path = ?").run(filePath);
        if (noteUnchanged || preservedLaneMatches('preference')) restorePreservedLane('preference');
        throw err;
      }
    }
  }

  const rows = { ids: insertedChunks.map(c => c.id), hashes: chunkHashes };
  const next = appendBaseOf(filePath, raw, content, detailed, kind, cut, rows, noteHash, options);
  if (next) recordAppendBase(db, filePath, next);
}

/**
 * What one indexing pass did. `total` counts the notes the walk could name, so `indexed + errors`
 * is always `total`; `skippedNonUtf8Names` names the notes that were never candidates, and they
 * are reported rather than counted as errors because nothing about them failed — the indexer
 * cannot address a file whose name is not valid UTF-8, so it declines to try, and the pass is
 * still complete for every note it could reach.
 */
export interface IndexResult {
  total: number;
  indexed: number;
  errors: number;
  /** Path below the vault of each skipped Markdown file, bad bytes written `\xNN`. */
  skippedNonUtf8Names: string[];
  /**
   * Path below the vault of each note over MAX_NOTE_BYTES, which was not read. Like a skipped name it is reported, not
   * counted: `total` leaves it out. Absent when there is none.
   */
  skippedTooLarge?: string[];
}

export async function indexVault(
  db: Database.Database,
  vaultPath: string,
  options: IndexOptions = {},
  concurrency = 5
): Promise<IndexResult> {
  // A name another OS or locale wrote can hold bytes that are not UTF-8. Read the directory as
  // bytes and name those files here instead of letting the walk return a path that exists
  // nowhere: for a FILE that path failed the first read and counted as an indexing error, and
  // for a FOLDER `scandir` threw inside the walk, so one such name aborted the whole pass and
  // not one note reached the index.
  const skippedNonUtf8Names: string[] = [];
  const files = await walkVault(vaultPath, {
    onNonUtf8Markdown: relPath => skippedNonUtf8Names.push(relPath),
  });
  const walked = files.length;
  const skippedTooLarge: string[] = [];
  let indexed = 0;
  let errors = 0;
  let fileIdx = 0;
  let active = 0;

  // Skipped names are reported even when they are the only Markdown in the vault: "nothing to
  // index" and "nothing indexable" must not read the same.
  if (walked === 0) return { total: 0, indexed: 0, errors: 0, skippedNonUtf8Names: skippedNonUtf8Names.sort() };

  console.log(`[index] starting: ${walked} files, concurrency ${concurrency}`);

  return new Promise((resolve) => {
    function onComplete() {
      const done = indexed + errors + skippedTooLarge.length;
      if (done % 50 === 0 || done === walked) {
        console.log(`[index] ${done}/${walked} files (${errors} errors)`);
      }
      if (done === walked) {
        resolve({
          total: walked - skippedTooLarge.length,
          indexed,
          errors,
          skippedNonUtf8Names: skippedNonUtf8Names.sort(),
          ...(skippedTooLarge.length > 0 ? { skippedTooLarge: skippedTooLarge.sort() } : {}),
        });
      } else {
        next();
      }
    }

    function next() {
      while (active < concurrency && fileIdx < walked) {
        const filePath = files[fileIdx++];
        active++;
        indexFile(db, filePath, options).then(
          () => {
            indexed++;
            active--;
            onComplete();
          },
          (err: unknown) => {
            active--;
            if (err instanceof NoteTooLargeError) {
              skippedTooLarge.push(path.relative(vaultPath, filePath));
              console.warn(`[index] ${filePath}: ${err.message}`);
            } else {
              errors++;
              console.error(`[index] error indexing ${filePath}:`, err);
            }
            onComplete();
          }
        );
      }
    }

    next();
  });
}

/**
 * Remove the facts an earlier build made of the engine's own daily-note headers (dailyNote.ts), and say how many. An
 * index written then holds one for every daily note, and a note whose bytes did not change is never rebuilt, so the row
 * would stay and be served (retrieve_memory answers it as a current fact). The server calls this when it starts, the
 * indexer when it passes over an unchanged daily note (it hands over the text it has just read); `filePath` narrows it
 * to one note.
 *
 * Nothing a person wrote is touched. A row goes only when it looks like what that indexer made of the header (a fact
 * named `updated` that no ledger event made, whose text is the note's own day as a Date) AND the note is one the engine
 * wrote: the front matter at the start of the file, read here, carries the engine's marker or is the complete front
 * matter the engine wrote before it had one (isEngineDailyNote). A person's note in the same folder with a natural
 * `updated:`, a note whose file is gone, or one that cannot be read, is not told to be the engine's, and its row stays.
 */
export function removeDailyHeaderFacts(db: Database.Database, filePath?: string, content?: string): number {
  if (filePath !== undefined && !isDailyNotePath(filePath)) return 0;
  const rows = (filePath === undefined
    ? db.prepare('SELECT id, source_path, object_text FROM facts WHERE predicate = ? AND event_id IS NULL').all(DAILY_NOTE_HEADER_KEY)
    : db.prepare('SELECT id, source_path, object_text FROM facts WHERE predicate = ? AND event_id IS NULL AND source_path = ?').all(DAILY_NOTE_HEADER_KEY, filePath)
  ) as Array<{ id: number; source_path: string; object_text: string | null }>;
  const byNote = new Map<string, number[]>();
  for (const row of rows) {
    if (typeof row.source_path !== 'string' || !isEarlierHeaderText(row.source_path, row.object_text)) continue;
    byNote.set(row.source_path, [...(byNote.get(row.source_path) ?? []), row.id]);
  }
  const ids: number[] = [];
  for (const [note, noteIds] of byNote) {
    const head = filePath !== undefined && content !== undefined ? content : readHead(note);
    if (head !== null && isEngineDailyNote(note, head)) ids.push(...noteIds);
  }
  if (ids.length === 0) return 0;
  const drop = db.prepare('DELETE FROM facts WHERE id = ?');
  db.transaction(() => {
    for (const id of ids) drop.run(id);
  })();
  return ids.length;
}

const HEAD_BYTES = 4096;

/** The start of a file; null when it cannot be read (a note that is gone proves nothing). */
function readHead(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
