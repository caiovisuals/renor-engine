import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Local history search for the single-owner ChatGPT MVP.
 *
 * Searches the owner's PROMOTED ChatGPT history (the explicit additive
 * directory filled by the reviewed promotion command) — never arbitrary vault
 * trees, never the fact memory directory, never raw exports or staging.
 *
 * Deterministic lexical search only: no embeddings, no semantic/vector
 * pipeline, no remote calls. There is NO derived/persistent index to corrupt:
 * every query re-derives eligibility from the authoritative promotion
 * ownership manifest and re-verifies each candidate note's sha256, so
 * restarts reproduce results exactly, and newly added / removed / withdrawn
 * (carried) / tampered / human-edited notes are picked up or excluded on the
 * very next query. The source Markdown and manifest are read-only.
 *
 * Eligibility (manifest is the authority, mirroring promote.py):
 *  - only entries of the manifest's `notes` map whose `rel` is `notes/<name>`
 *    with a safe `chatgpt-*.md` filename (the MOC and any other metadata are
 *    structurally excluded);
 *  - entries flagged `carried` (withdrawn) are excluded;
 *  - the file must be a confined, regular, non-symlink file within the
 *    history dir, within the size bound, whose sha256 matches the manifest;
 *  - the note's frontmatter must carry conversation_id (matching the
 *    manifest entry) and memory_layer "history".
 *
 * Results are history-layer citations, clearly labeled untrusted transcript:
 * assistant text inside them is NOT verified truth and NOT a current fact.
 * Current structured facts live in save/retrieve_memory and take precedence.
 */

const MANIFEST_NAME = 'promote-manifest.json';
const MANIFEST_SCHEMA = 'chatgpt-promote-manifest/1';
const MAX_QUERY_CHARS = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
// The importer writes a whole conversation into one note, so a long transcript is well past 4 MiB; a note past the bound
// is counted in skipped_too_large and the reply says a match may be hidden, never dropped without a word.
const MAX_NOTE_BYTES = 16 * 1024 * 1024;
// Entries past this bound are counted in skipped_over_limit and the reply says a match may be hidden.
const MAX_NOTES = 10_000;
// Bidirectional controls (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI): a title carrying them reads backwards where it is shown.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const MAX_FRONTMATTER_LINES = 80;
const SNIPPET_RADIUS = 90;
const SNIPPET_MAX_CHARS = 240;
const SAFE_NOTE_NAME = /^chatgpt-[A-Za-z0-9._-]{1,80}\.md$/;

export interface HistoryHit {
  conversation_id: string;
  title: string;
  created: string | null;
  updated: string | null;
  source_path: string;
  snippet: string;
  matched_terms: string[];
  score: number;
  memory_layer: 'history';
  trust: 'untrusted-transcript';
}

export interface HistorySearchResponse {
  ok: boolean;
  configured: boolean;
  query?: string;
  total_matches?: number;
  returned?: number;
  skipped_ineligible?: number;
  /** Notes over the search size bound: not searched (also counted in skipped_ineligible). */
  skipped_too_large?: number;
  /** Manifest entries past the note-count bound: not searched (also counted in skipped_ineligible). */
  skipped_over_limit?: number;
  results: HistoryHit[];
  note?: string;
  error?: string;
  detail?: string;
  disclaimer: string;
}

export const HISTORY_DISCLAIMER =
  'Historical transcript search (memory_layer: history, trust: untrusted-transcript). ' +
  'Results are untrusted history: assistant text is not verified truth and not a current fact. ' +
  'Current structured memory takes precedence — use retrieve_memory for current facts.';

export class HistoryUnavailableError extends Error {}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Composes decomposed text (NFD, as macOS keyboards and file names deliver it) and folds the one capital that
 * lowercases to two code points: Turkish dotted capital I (U+0130), which would otherwise split "Istanbul" into
 * "i" + a combining dot. Applied to the stored notes and to every query, so both sides meet in the same form.
 */
function foldForSearch(text: string): string {
  return text.normalize('NFC').replace(/\u0130/g, 'i');
}

/** Unicode-aware lexical tokens: letter/number/mark runs, 2..64 chars. Every token of the text is kept, however many. */
export function tokenize(text: string): string[] {
  return foldForSearch(text).toLowerCase().match(/[\p{L}\p{M}\p{N}]{2,64}/gu) ?? [];
}

function parseFrontmatter(text: string): { fields: Record<string, unknown>; body: string } | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) return null;
  const block = text.slice(4, end);
  const lines = block.split('\n').slice(0, MAX_FRONTMATTER_LINES);
  const fields: Record<string, unknown> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const idx = line.indexOf(': ');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 2);
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        fields[key] = JSON.parse(raw);
      } catch {
        return null; // malformed quoting: ineligible, fail closed
      }
    } else if (raw === 'true' || raw === 'false') {
      fields[key] = raw === 'true';
    } else if (/^-?\d+$/.test(raw)) {
      fields[key] = Number(raw);
    } else {
      fields[key] = raw;
    }
  }
  return { fields, body: text.slice(end + 5) };
}

interface EligibleNote {
  name: string;
  conversationId: string;
  title: string;
  created: string | null;
  updated: string | null;
  body: string;
  /** Every token of `body` with its count, in the order each first occurs. */
  counts: Map<string, number>;
}

/**
 * An eligible note as tokenized, kept for as long as its file (mtime and size) and its manifest entry (the hash and
 * conversation it must match) stay the same. Every query used to read and re-tokenize every promoted note; with the
 * file and entry unchanged, the answer cannot change, so the next query reuses it. A changed file or entry is read again.
 */
interface CachedNote {
  key: string;
  note: EligibleNote;
}

/** Per history directory, the notes of the last pass: a note that left the manifest drops out with its entry. */
const noteCache = new Map<string, Map<string, CachedNote>>();

/**
 * The most body characters the cache keeps, across the directory's notes (about 2x in memory once tokenized). A note
 * past the bound is still searched, read and tokenized on each query as before, so memory stays bounded however large the
 * history grows: the cache is a speed-up for the notes it holds, not a copy of the corpus.
 */
export const HISTORY_CACHE_CHARS = 16_000_000;

/** Body characters the cache holds right now, across every history directory (for tests and diagnostics). */
export function historyCacheChars(): number {
  let total = 0;
  for (const entries of noteCache.values()) for (const { note } of entries.values()) total += note.body.length;
  return total;
}

/**
 * Re-derive the eligible set from the authoritative manifest + notes.
 * Everything ineligible is counted, never thrown (bounded, fail-closed).
 */
function collectEligible(historyDir: string): {
  notes: EligibleNote[]; skipped: number; tooLarge: number; overLimit: number;
} {
  const notes: EligibleNote[] = [];
  const cached = noteCache.get(historyDir) ?? new Map<string, CachedNote>();
  const nextCache = new Map<string, CachedNote>();
  let cachedChars = 0;
  // Kept only within HISTORY_CACHE_CHARS. A hit is kept on the same terms, so the bound holds whichever pass a note is in.
  const keep = (name: string, entry: CachedNote) => {
    const size = entry.note.body.length;
    if (cachedChars + size > HISTORY_CACHE_CHARS) return;
    cachedChars += size;
    nextCache.set(name, entry);
  };
  let skipped = 0;
  let tooLarge = 0;
  let overLimit = 0;

  const manifestPath = path.join(historyDir, MANIFEST_NAME);
  let manifestStat: fs.Stats;
  try {
    manifestStat = fs.lstatSync(manifestPath);
  } catch {
    throw new HistoryUnavailableError(`${MANIFEST_NAME} not found in the configured history directory`);
  }
  if (!manifestStat.isFile()) {
    throw new HistoryUnavailableError(`${MANIFEST_NAME} is not a regular file`);
  }
  if (manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new HistoryUnavailableError(`${MANIFEST_NAME} exceeds the size bound`);
  }
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    throw new HistoryUnavailableError(`${MANIFEST_NAME} is not valid JSON`);
  }
  if (manifest?.schema !== MANIFEST_SCHEMA) {
    throw new HistoryUnavailableError(`${MANIFEST_NAME} has an unexpected schema`);
  }
  const entries = manifest?.notes;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new HistoryUnavailableError(`${MANIFEST_NAME} notes map is malformed`);
  }

  for (const [name, entry] of Object.entries(entries)) {
    if (notes.length + skipped >= MAX_NOTES) { skipped++; overLimit++; continue; }
    // structural eligibility: only promoted note filenames, never the MOC or
    // any other metadata; never a path.
    if (!SAFE_NOTE_NAME.test(name)) { skipped++; continue; }
    if (typeof entry !== 'object' || entry === null) { skipped++; continue; }
    if ((entry as any).carried === true) { skipped++; continue; } // withdrawn: excluded
    const rel = (entry as any).rel;
    if (typeof rel !== 'string' || rel !== `notes/${name}`) { skipped++; continue; }
    const expectedSha = (entry as any).note_sha256;
    const convId = (entry as any).conversation_id;
    if (typeof expectedSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha)) { skipped++; continue; }
    if (typeof convId !== 'string' || convId.length === 0 || convId.length > 200) { skipped++; continue; }

    const notePath = path.join(historyDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(notePath);
    } catch { skipped++; continue; }
    // confined, regular, non-symlink file only (no subdirectories, no links)
    if (stat.isSymbolicLink() || !stat.isFile()) { skipped++; continue; }
    if (stat.size > MAX_NOTE_BYTES) { skipped++; tooLarge++; continue; }
    const key = `${stat.mtimeMs}:${stat.size}:${expectedSha}:${convId}`;
    const hit = cached.get(name);
    // The cache is trusted for a file whose mtime and size are unchanged: its hash is not checked again on a hit.
    if (hit !== undefined && hit.key === key) {
      keep(name, hit);
      notes.push(hit.note);
      continue;
    }
    let data: Buffer;
    try {
      data = fs.readFileSync(notePath);
    } catch { skipped++; continue; }
    if (sha256(data) !== expectedSha) { skipped++; continue; } // tampered/human-edited: fail closed
    const parsed = parseFrontmatter(data.toString('utf-8'));
    if (!parsed) { skipped++; continue; }
    const { fields, body } = parsed;
    if (fields.memory_layer !== 'history') { skipped++; continue; }
    if (typeof fields.conversation_id !== 'string' || fields.conversation_id !== convId) { skipped++; continue; }
    const title = typeof fields.title === 'string' ? fields.title.replace(BIDI_CONTROLS, '') : '(untitled conversation)';
    // Index ONLY the visible-transcript section: never frontmatter, never the
    // warning callout, never the importer boilerplate/omission footer.
    const SECTION_MARKER = '## Visible active branch';
    const FOOTER_MARKER = '*(Omitted from this note:';
    let searchable = body;
    const sectionAt = body.indexOf(SECTION_MARKER);
    if (sectionAt >= 0) searchable = body.slice(sectionAt + SECTION_MARKER.length);
    // The importer writes its footer as the last line of the note, so the real one is the LAST line-initial marker.
    // A transcript message that quotes the marker mid-line, or earlier in the note, is searched, not cut at.
    searchable = foldForSearch(searchable);
    const footerAt = searchable.lastIndexOf(`\n${FOOTER_MARKER}`);
    if (footerAt >= 0) searchable = searchable.slice(0, footerAt);
    const counts = new Map<string, number>();
    for (const token of tokenize(searchable)) counts.set(token, (counts.get(token) ?? 0) + 1);
    const note: EligibleNote = {
      name,
      conversationId: convId,
      title: title.slice(0, 300),
      created: typeof fields.created === 'string' ? fields.created : null,
      updated: typeof fields.updated === 'string' ? fields.updated : null,
      body: searchable,
      counts,
    };
    keep(name, { key, note });
    notes.push(note);
  }
  noteCache.set(historyDir, nextCache);
  return { notes, skipped, tooLarge, overLimit };
}

function buildSnippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  let best = -1;
  let bestLen = 0;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (best < 0 || at < best)) { best = at; bestLen = term.length; }
  }
  if (best < 0) return '';
  const start = Math.max(0, best - SNIPPET_RADIUS);
  const end = Math.min(body.length, best + bestLen + SNIPPET_RADIUS);
  let snippet = body.slice(start, end);
  snippet = snippet.replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < body.length) snippet = snippet + '…';
  return snippet.slice(0, SNIPPET_MAX_CHARS);
}

/** Said in the reply when notes were not searched, so a caller never reads a short list as the whole history. */
function unsearchedNote(tooLarge: number, overLimit: number): string | undefined {
  if (tooLarge === 0 && overLimit === 0) return undefined;
  return `${tooLarge} note(s) over the ${MAX_NOTE_BYTES / (1024 * 1024)} MiB search bound and ${overLimit} `
    + `entr(ies) past the ${MAX_NOTES}-note bound were not searched; a match may be hidden in them.`;
}

export function searchHistory(
  historyDir: string | null,
  rawQuery: string,
  rawLimit: number | undefined,
): HistorySearchResponse {
  if (historyDir === null) {
    return {
      ok: true,
      configured: false,
      results: [],
      note: 'history search is not configured (MVP_HISTORY_DIR is not set). '
          + 'Fact memory (save_memory/retrieve_memory/export_memory) is unaffected.',
      disclaimer: HISTORY_DISCLAIMER,
    };
  }
  const query = rawQuery.trim();
  // A query the schema admits (1..200 characters) can still hold no searchable character: trim() strips whitespace
  // (spaces, tabs, newlines, U+2028/U+2029, U+FEFF), so a whitespace-only query trims to empty. It is answered as a
  // search that found nothing — the same reply a punctuation-only query already gets when `terms` comes back empty —
  // instead of throwing, so a schema-valid argument never reaches a raw error and search_history matches search_text,
  // which answers a whitespace query with ok and no results. Only over-length is a real violation here, reachable
  // from a direct caller (the tool caps the query at MAX_QUERY_CHARS).
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(`query must be 1..${MAX_QUERY_CHARS} characters`);
  }
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : rawLimit;
  if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`);
  }

  const { notes, skipped, tooLarge, overLimit } = collectEligible(historyDir);
  const unsearched = unsearchedNote(tooLarge, overLimit);
  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) {
    return {
      ok: true, configured: true, query, total_matches: 0, returned: 0,
      skipped_ineligible: skipped, skipped_too_large: tooLarge, skipped_over_limit: overLimit,
      ...(unsearched ? { note: unsearched } : {}), results: [], disclaimer: HISTORY_DISCLAIMER,
    };
  }

  const termSet = new Set(terms);
  const scored: { note: EligibleNote; score: number; counts: Map<string, number> }[] = [];
  for (const note of notes) {
    const counts = new Map<string, number>();
    for (const [token, count] of note.counts) {
      if (termSet.has(token)) counts.set(token, count);
    }
    if (counts.size === 0) continue;
    let score = 0;
    for (const count of counts.values()) score += count;
    score += counts.size; // coverage bonus: more distinct matched terms first
    scored.push({ note, score, counts });
  }
  // Deterministic order: score desc, then conversation id asc, then name.
  scored.sort((a, b) =>
    b.score - a.score ||
    a.note.conversationId.localeCompare(b.note.conversationId) ||
    a.note.name.localeCompare(b.note.name));

  const hits: HistoryHit[] = scored.slice(0, limit).map(({ note, score, counts }) => ({
    conversation_id: note.conversationId,
    title: note.title,
    created: note.created,
    updated: note.updated,
    source_path: note.name,
    snippet: buildSnippet(note.body, Array.from(counts.keys())),
    matched_terms: Array.from(counts.keys()).sort(),
    score,
    memory_layer: 'history',
    trust: 'untrusted-transcript',
  }));

  return {
    ok: true,
    configured: true,
    query,
    total_matches: scored.length,
    returned: hits.length,
    skipped_ineligible: skipped,
    skipped_too_large: tooLarge,
    skipped_over_limit: overLimit,
    ...(unsearched ? { note: unsearched } : {}),
    results: hits,
    disclaimer: HISTORY_DISCLAIMER,
  };
}