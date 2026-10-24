import type Database from '../db/sqlite';
import { readUntilWrite } from '../db/readCache';
import { prepareOnce } from '../db/statements';
import type { EmbeddingProvider } from '../embeddings/types';
import type { Engine } from './engine';
import type { RetrievalProbe } from '../retrieval/semantic';
import { currentFactById, type CurrentFact } from '../memory/factTerms';
import { bestPacked, packLane, type FactSnapshot, type PackedLane } from './factLanePack';
import { normalizeScope, savedScopeSqlPredicate } from './scope';

/**
 * get_context relevance signal: "does anything on file actually match the request?"
 *
 * Without it an agent gets the same five confident-looking memories for a question
 * nothing on file answers, and fills the gap by guessing. The signal is the best
 * embedding similarity between the query and (a) the note chunks get_context returned
 * and (b) a clean "attribute: value" rendering of every current fact, compared with a
 * bar calibrated per embedding model on fixtures/relevance (method, confusion matrices
 * and the chosen bar: docs/evals/results/RELEVANCE-SIGNAL-20261002.md).
 *
 * Why not the lexical term coverage RENOR_READ_HONESTY uses: coverage counts query
 * words found in the best item, so a paraphrase ("Where am I based?" for
 * home_city = Lisbon) scores 0 even when retrieval found the right memory. Why a fact
 * rendering and not just the ledger chunk: the chunk is mostly event boilerplate (ids,
 * timestamps, "kind: store"), which flattens every similarity toward the same value;
 * the rendering is only the claim.
 *
 * The signal is cheap, and an agent reads `relevant: true` as "the answer is below", so the
 * response holds the match it reports (`matchedOn`), the closest fact or note chunk: the
 * budget makes room for it, cutting other items if it must (agentMemory.ts), and when it
 * does not fit max_tokens even on its own there is no verdict rather than one about something
 * the response lacks. The current fact closest to the request, when it clears the bar on its
 * own (`closestFact`), is listed when the words of the request did not find it: in their
 * place when they found none, else after the facts they found, in the room the rest leaves
 * unless it is the match reported. It never takes the place of a fact they found: a
 * rendering has no subject, so the closest one is often a fact that mentions the project
 * ("role: product manager for Atlas" is near every Atlas question) or another ticket's
 * status, and room taken from the rest for it cost answers. Nothing else is added, removed or
 * reordered, and it adds no embedding call to get_context: the query vector comes from the
 * semantic search that already ran, and fact vectors are embedded once, in the background.
 * Two cases are judged without a cosine to compare: a read that found no note by meaning and
 * holds no current fact is "not relevant" (similarity null), and a request that names
 * something nothing in the scope read mentions needs a match closer by UNKNOWN_NAME_MARGIN.
 * It is absent (never a guess) whenever it cannot judge: flag off, no query vector, no
 * calibrated bar for the embedding model, or fact vectors still warming - a "not relevant"
 * verdict needs every current fact compared.
 */

/** RENOR_CONTEXT_RELEVANCE: 1/true/yes/on enables, 0/false/no/off disables. */
export const CONTEXT_RELEVANCE_FLAG = 'RENOR_CONTEXT_RELEVANCE';

/** RENOR_CONTEXT_RELEVANCE_MIN: explicit bar, for an embedding model with no calibrated one. */
export const CONTEXT_RELEVANCE_MIN_ENV = 'RENOR_CONTEXT_RELEVANCE_MIN';

/**
 * Shipped default: on, because the held-out calibration met the pre-registered bar (false abstentions on
 * answerable questions < 5% AND most unanswerable flagged, at both workspace sizes). It can only be on, and
 * can only speak, for an embedding model with a calibrated bar (CALIBRATED_BARS) or an explicit
 * RENOR_CONTEXT_RELEVANCE_MIN. tests/mvp/context-relevance-calibration.test.ts asserts this constant and the
 * recorded calibration cannot disagree.
 */
export const CONTEXT_RELEVANCE_DEFAULT_ON = true;

/**
 * Calibrated bars, keyed `<MVP_EMBEDDING_PROVIDER>:<model>:<dimensions>`. Cosine scales
 * differ by model and output size, so a bar never transfers between them.
 */
export const CALIBRATED_BARS: Readonly<Record<string, number>> = {
  'vertex:gemini-embedding-001:768': 0.63,
};

export interface ContextRelevance {
  relevant: boolean;
  /** Only when `relevant` is false: why, in words an agent can pass on to the user. */
  reason?: string;
  /** Best raw cosine between the request and what is on file; null when the read had nothing to compare (no note found by meaning, no current fact). */
  similarity: number | null;
  /** The bar it was compared with: higher by UNKNOWN_NAME_MARGIN when the request names something nothing on file mentions. */
  bar: number;
  /**
   * Only in search_memory, and only when `relevant` is true: the fact the verdict was judged on, named here because
   * the page top_k leaves no room to list it (agentMemory.ts `searchRelevance`). The same fact get_context lists rather
   * than names; a search may not spend a slot past top_k. Absent when the page holds the fact.
   */
  fact?: { subject: string; predicate: string; object: string; scope: string };
}

export const NO_STRONG_MATCH =
  'no stored fact or note closely matches this request; the listed items are only the nearest ones';

/** When `names` were looked for and nothing on file mentions them. */
export const notMentioned = (names: string[]): string =>
  `nothing on file mentions ${names.join(', ')}; the listed items are only the nearest ones`;

/**
 * How much closer a match must be when the request names something that nothing on file mentions ("What is the
 * Quillmoor pricing?" on a workspace that never said Quillmoor): such a request is about something else than anything
 * on file, and its match is on the generic part ("pricing"). Live, those sat at 0.646-0.651 over the 0.63 bar. Chosen
 * on the dev questions, where a name a semantic model reads across languages ("Wie heißt meine Frau?", 0.708) must
 * stay relevant, and checked on the held-out ones: no answerable question is lost
 * (tests/mvp/context-relevance-calibration.test.ts).
 */
export const UNKNOWN_NAME_MARGIN = 0.05;

/** Capitalized in English, but a time rather than the name of something on file. */
const CALENDAR_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);

/**
 * The names in a request: capitalized words that do not open a sentence ("Quillmoor" in "What is the Quillmoor
 * pricing?"), without a possessive. Not "I", a weekday or a month. A sentence's first word is capitalized for that
 * alone, so it is never taken for a name.
 */
export function requestNames(query: string): string[] {
  const names = new Set<string>();
  let opening = true;
  for (const [token] of query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*|[.?!:;]+(?=\s|$)|[¿¡]/gu)) {
    if (!/^[\p{L}\p{N}]/u.test(token)) {
      opening = true;
      continue;
    }
    const word = token.replace(/['’]s$/i, '').replace(/['’-]+$/, '');
    if (!opening && /^\p{Lu}/u.test(word) && !/^I(['’]\p{L}+)?$/u.test(word) && !CALENDAR_WORDS.has(word.toLowerCase())) names.add(word);
    opening = false;
  }
  return [...names];
}

export function contextRelevanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CONTEXT_RELEVANCE_FLAG] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return CONTEXT_RELEVANCE_DEFAULT_ON;
}

export function embeddingModelKey(provider: string, model: string | undefined, dims: number | undefined): string {
  return `${provider}:${model ?? ''}:${dims ?? ''}`;
}

export function resolveRelevanceBar(
  modelKey: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = (env[CONTEXT_RELEVANCE_MIN_ENV] ?? '').trim();
  if (raw !== '') {
    const explicit = Number(raw);
    if (Number.isFinite(explicit)) return explicit;
  }
  return modelKey && modelKey in CALIBRATED_BARS ? CALIBRATED_BARS[modelKey] : null;
}

/** Whether get_context can return the signal, i.e. whether agents should be told about it: on, embeddings configured, a bar to judge by. */
export function contextRelevanceArmed(
  engine: Pick<Engine, 'provider' | 'modelKey'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(engine.provider) && contextRelevanceEnabled(env) && resolveRelevanceBar(engine.modelKey, env) !== null;
}

/** Appended to the get_context tool description only while the signal is armed. */
export const CONTEXT_RELEVANCE_GUIDANCE =
  ' If the result has relevance.relevant === false, nothing on file closely matches this request: '
  + 'the listed items are only the nearest ones, so do not present them as an answer unless one clearly '
  + 'answers it; say you have no memory of it and ask the user.';

/**
 * Appended to the get_context description after the guidance, while the signal is armed: the one case in which
 * max_tokens does not drop the item that ranks last first (agentMemory.ts keeps what a relevant verdict was judged on).
 */
export const CONTEXT_RELEVANCE_KEEPS_MATCH =
  ' When relevance.relevant is true, the closest match is in the result, or the newer relevant match the budget kept in its place: max_tokens keeps one of them even if another item has to be dropped to make room for it.';

/**
 * Appended to the get_context description after the two sentences above, while the signal is armed (the model has a bar to
 * judge by): what the budget keeps first when the matches do not all fit (agentMemory.ts newestMatchAbove, sessionMatesAbove).
 */
export const CONTEXT_BUDGET_KEEPS_NEWEST =
  ' When the matches do not all fit, the newest match above the relevance bar is kept first, with the pieces of its session that say most about the question (at most four, in at most 60% of the budget), then the best-scoring ones, so the latest relevant statement is not the one the budget drops.';

/**
 * Appended to the search_memory description while the signal is armed. `relevance.fact` is search's alone, and only
 * for the one case where the page could not carry the match: the fact is named, not listed.
 */
export const SEARCH_RELEVANCE_GUIDANCE =
  ' A relevance object says whether anything on file closely matches the query: relevant is true only when the closest match is among the hits, and when it is false the hits are only the nearest ones, so do not present them as an answer unless one clearly answers it.'
  + ' When relevant is true and the closest match is a remembered fact that top_k left no room to list, relevance.fact names it (subject, predicate, object, scope); you can answer from it, and the hits are still at most top_k in all.';

/**
 * Most current facts the lane compares per call. A tenant with more is not silently truncated: the lane is
 * reported incomplete, so it can still prove relevance but can never be the basis of "nothing matches".
 * The fact list is read once until the next write. Each call then dots the query with the unit vectors
 * already stored for those facts (scripts/eval/relevance-latency.ts measured the uncached list).
 */
export const FACT_CEILING = 5_000;
/** Vectors of no-longer-current facts kept before the store is pruned to the live set. */
const STALE_VECTORS_KEPT = 256;
/** Texts per embedding request, and requests in flight, while fact vectors are filled. */
const FILL_BATCH = 32;
const FILL_CONCURRENCY = 4;
/** After a failed fill, how long reads leave the embedding backend alone before trying again. */
const FILL_RETRY_MS = 30_000;

interface FactVectorSlot {
  /** Unit-length vectors of fact renderings, for the life of the process. */
  vectors: Map<string, Float32Array>;
  filling: Promise<void> | null;
  /** Epoch ms before which a failed fill is not retried: a failing backend is not hit by every read. */
  retryAfter: number;
  /** Bumped when `vectors` gains or loses a vector, so a packed lane built earlier is not reused. */
  epoch: number;
  /** Packed lanes keyed by scope and ceiling. Invalid once `epoch` or the fact snapshot changes. */
  packed: Map<string, PackedLane>;
}

/** Per embedding provider, so two models (or two test engines) never share vectors. */
const slots = new WeakMap<object, FactVectorSlot>();

function slotFor(provider: object): FactVectorSlot {
  let slot = slots.get(provider);
  if (!slot) slots.set(provider, slot = { vectors: new Map(), filling: null, retryAfter: 0, epoch: 0, packed: new Map() });
  return slot;
}

export function renderFactForRelevance(predicate: string, object: string): string {
  return `${predicate.replace(/_/g, ' ')}: ${object}`;
}

function unit(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Embeds `texts` into the slot, FILL_CONCURRENCY requests at a time. A failed batch leaves its texts for the next call. */
async function fill(provider: EmbeddingProvider, slot: FactVectorSlot, texts: string[]): Promise<void> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += FILL_BATCH) batches.push(texts.slice(i, i + FILL_BATCH));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let b = next++; b < batches.length; b = next++) {
      const batch = batches[b];
      const fresh = await provider.embed(batch);
      if (fresh.length !== batch.length) throw new Error('embedding provider returned a wrong vector count');
      batch.forEach((text, i) => slot.vectors.set(text, unit(fresh[i])));
      slot.epoch++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILL_CONCURRENCY, batches.length) }, worker));
}

export interface FactLane {
  /** Best cosine between the query and the fact renderings that have a vector yet; null when none do. */
  similarity: number | null;
  /** False while a current fact still has no vector, or when there are more facts than were compared: a better match may be waiting in one. */
  complete: boolean;
  /** Row id of the newest current fact rendered the way that scored `similarity`. */
  bestFactId?: number;
}

/** What a lane was asked for (any scope, or one; how many facts at most): the key its snapshot and its pack are kept under. */
function factLaneKey(scope: string | undefined, ceiling: number): string {
  return `${scope === undefined ? '*' : normalizeScope(scope)}\0${ceiling}`;
}

function loadFactSnapshot(db: Database.Database, scope: string | undefined, ceiling: number): FactSnapshot {
  const inScope = scope === undefined ? undefined : savedScopeSqlPredicate(normalizeScope(scope), 'f.scope'); // any spelling of it
  const select = `SELECT f.id AS id, f.predicate AS predicate, f.object_text AS object
     FROM facts f
     WHERE f.valid_to IS NULL AND f.source_path = '_mcp_'${inScope ? ` AND ${inScope.sql}` : ''}`;
  const scopeArgs = inScope?.params ?? [];
  type Row = { id: number; predicate: string; object: string };
  let rows = prepareOnce(db, `${select} LIMIT ?`).all(...scopeArgs, ceiling + 1) as Row[];
  const truncated = rows.length > ceiling;
  if (truncated) {
    // Newest by row id: a reverse scan of the primary key, no sort. Only positives can come of this subset.
    rows = prepareOnce(db, `${select} ORDER BY f.id DESC LIMIT ?`).all(...scopeArgs, ceiling) as Row[];
  }
  // Each rendering once, with the newest fact rendered that way: the one a match is shown as.
  const newest = new Map<string, number>();
  for (const r of rows) {
    const rendering = renderFactForRelevance(r.predicate, r.object);
    const seen = newest.get(rendering);
    if (seen === undefined || r.id > seen) newest.set(rendering, r.id);
  }
  return { pairs: [...newest], truncated };
}

/** The best fact when there is no matrix to read (vectors of two lengths) or the query is of another length: one lookup and one dot per fact. */
function bestFromSlot(q: Float32Array, snapshot: FactSnapshot, slot: FactVectorSlot): { score: number; id: number } | null {
  let best: number | null = null;
  let id = -1;
  for (const [rendering, factId] of snapshot.pairs) {
    const v = slot.vectors.get(rendering);
    if (!v) continue;
    const s = dot(q, v);
    if (best === null || s > best) { best = s; id = factId; }
  }
  return best === null ? null : { score: best, id };
}

/** Drop vectors of facts that are no longer in this snapshot, then embed what is still missing. Same trigger as before. */
function fillMissing(provider: EmbeddingProvider, slot: FactVectorSlot, snapshot: FactSnapshot, missing: string[]): void {
  if (missing.length === 0 || slot.filling || Date.now() < slot.retryAfter) return;
  if (slot.vectors.size > snapshot.pairs.length + STALE_VECTORS_KEPT) {
    const live = new Set(snapshot.pairs.map(([rendering]) => rendering));
    let dropped = false;
    for (const key of slot.vectors.keys()) if (!live.has(key)) { slot.vectors.delete(key); dropped = true; }
    // Live rows were not dropped, so a lane packed from them is still the same dots.
    if (dropped) slot.epoch++;
  }
  const run = slot.filling = fill(provider, slot, missing)
    .catch(() => { slot.retryAfter = Date.now() + FILL_RETRY_MS; /* advisory: retried later for what is still missing */ })
    .finally(() => { if (slot.filling === run) slot.filling = null; });
}

/**
 * Best similarity between the query vector and the current facts (scope-filtered).
 * Never waits on the embedding backend: facts without a vector yet start a background
 * fill and are reported through `complete: false`; what is left is a dot product per fact.
 * `complete` is true only when EVERY in-scope current fact was compared: past `ceiling`
 * facts only the newest are, and the lane says so.
 */
export function factLane(
  db: Database.Database,
  provider: EmbeddingProvider,
  queryVector: ArrayLike<number>,
  scope?: string,
  ceiling = FACT_CEILING,
): FactLane {
  const key = factLaneKey(scope, ceiling);
  // The rows change only when something is written. Vectors arrive later, from the background fill.
  const snapshot = readUntilWrite(db, `factLane\0${key}`, () => loadFactSnapshot(db, scope, ceiling));
  const slot = slotFor(provider);
  let packed = slot.packed.get(key);
  if (!packed || packed.snapshot !== snapshot || packed.epoch !== slot.epoch) {
    packed = packLane(snapshot, slot.vectors, slot.epoch);
    if (slot.packed.size >= 8) slot.packed.clear();
    slot.packed.set(key, packed);
  }
  fillMissing(provider, slot, snapshot, packed.missing);
  if (packed.epoch !== slot.epoch) packed.epoch = slot.epoch;
  const q = unit(queryVector);
  const found = packed.matrix && q.length === packed.dim
    ? (() => {
      const best = bestPacked(q, packed.matrix!, packed.ids.length, packed.dim);
      return best ? { score: best.score, id: packed.ids[best.index] } : null;
    })()
    : bestFromSlot(q, snapshot, slot);
  return {
    similarity: found ? found.score : null,
    complete: !snapshot.truncated && packed.missing.length === 0,
    ...(found ? { bestFactId: found.id } : {}),
  };
}

/**
 * Cosine between `queryVector` and each of `texts` (fact renderings, `renderFactForRelevance`), read from the same
 * per-provider store the fact lane fills, through the same embedding provider the notes are searched with. A text the
 * store lacks is embedded now (awaited, FILL_BATCH at a time), so a caller that needs the answer for this read gets it.
 * Null when that fails, or while the backend is in the pause after a failed fill: the caller answers by words instead.
 */
export async function similaritiesTo(
  provider: EmbeddingProvider,
  texts: readonly string[],
  queryVector: ArrayLike<number>,
): Promise<Map<string, number> | null> {
  const slot = slotFor(provider);
  const missing = [...new Set(texts)].filter(text => !slot.vectors.has(text));
  if (missing.length > 0) {
    if (Date.now() < slot.retryAfter) return null;
    try {
      await fill(provider, slot, missing);
    } catch {
      slot.retryAfter = Date.now() + FILL_RETRY_MS;
      return null;
    }
  }
  const q = unit(queryVector);
  const out = new Map<string, number>();
  for (const text of texts) {
    const v = slot.vectors.get(text);
    if (v && v.length === q.length) out.set(text, dot(q, v));
  }
  return out;
}

/** Resolves once the fact vectors a call would need are embedded (or a fill failed): for tests, calibration, warm-up. */
export async function warmFactVectors(
  db: Database.Database,
  provider: EmbeddingProvider,
  scope?: string,
): Promise<boolean> {
  const probeVector = new Float32Array(provider.dimensions).fill(1);
  slotFor(provider).retryAfter = 0; // an explicit warm-up is not held back by an earlier failure
  for (let attempt = 0; attempt < 4; attempt++) {
    if (factLane(db, provider, probeVector, scope).complete) return true;
    await slotFor(provider).filling;
  }
  return factLane(db, provider, probeVector, scope).complete;
}

/** The signal is the best match across both lanes; either lane alone may be unavailable. */
export function combineSimilarity(chunk: number | null, fact: number | null): number | null {
  if (chunk === null) return fact;
  if (fact === null) return chunk;
  return Math.max(chunk, fact);
}

export function assessContextRelevance(
  topSimilarity: number | null,
  bar: number | null,
): ContextRelevance | null {
  if (topSimilarity === null || bar === null || !Number.isFinite(topSimilarity)) return null;
  // Decide on the rounded value the caller sees, so a reported similarity equal to
  // the bar can never be reported irrelevant.
  const similarity = Math.round(topSimilarity * 1000) / 1000;
  const relevant = similarity >= bar;
  return { relevant, ...(relevant ? {} : { reason: NO_STRONG_MATCH }), similarity, bar };
}

export interface RelevanceInputs {
  db: Database.Database;
  engine: Engine;
  scope?: string;
  /** From the semantic search get_context already ran: the query vector and the best returned-chunk cosine. */
  probe: RetrievalProbe;
  env?: NodeJS.ProcessEnv;
  /** Calibration seam: receives the two lane values before they are combined. */
  components?: { chunk: number | null; fact: number | null };
  /** The request, for the names it gives (`requestNames`). */
  query?: string;
  /** Whether a name is on file in the scope read (agentMemory.ts `nameOnFile`). Without it, names are not looked up. */
  onFile?: (name: string) => boolean;
}

export interface RelevanceAssessment {
  relevance: ContextRelevance;
  /** The current fact closest to the request, when it clears the bar on its own. */
  closestFact?: CurrentFact;
  /**
   * Only when relevant: what `similarity` reports, the closest fact (`closestFact`) or the closest returned note chunk
   * (`probe.topHit`). A tie is the fact.
   */
  matchedOn?: 'fact' | 'chunk';
}

/** Advisory by design: any failure here yields no signal rather than a failed get_context. */
export function assessQueryRelevance(input: RelevanceInputs): RelevanceAssessment | null {
  const { db, engine, scope, probe, env } = input;
  const bar = resolveRelevanceBar(engine.modelKey, env);
  // No query vector means retrieval embedded nothing (empty index): the signal does not pay for one.
  if (bar === null || !engine.provider || !probe.queryVector) return null;
  try {
    const chunk = probe.topSimilarity ?? null;
    const fact = factLane(db, engine.provider, probe.queryVector, scope);
    if (input.components) { input.components.chunk = chunk; input.components.fact = fact.similarity; }
    const best = combineSimilarity(chunk, fact.similarity);
    // Nothing to compare: the read found no note by meaning and holds no current fact, so nothing on file is close to
    // the request (withheld while fact vectors are warming, as any "not relevant" is).
    if (best === null) return fact.complete ? { relevance: { relevant: false, reason: NO_STRONG_MATCH, similarity: null, bar } } : null;
    // A match just over the bar for a request that names something nothing on file mentions has to be closer.
    const raised = Math.round((bar + UNKNOWN_NAME_MARGIN) * 1000) / 1000;
    const unknown = input.onFile && assessContextRelevance(best, bar)?.relevant && !assessContextRelevance(best, raised)?.relevant
      ? requestNames(input.query ?? '').filter(name => !input.onFile!(name))
      : [];
    const judgedBar = unknown.length > 0 ? raised : bar;
    const verdict = assessContextRelevance(best, judgedBar);
    // A match found among some facts proves relevance; "nothing matches" needs all of them compared.
    if (!verdict || (!verdict.relevant && !fact.complete)) return null;
    if (unknown.length > 0) verdict.reason = notMentioned(unknown);
    const closestFact = fact.bestFactId !== undefined && assessContextRelevance(fact.similarity, judgedBar)?.relevant
      ? currentFactById(db, fact.bestFactId)
      : undefined;
    const matchedOn = !verdict.relevant ? undefined : chunk === null || (fact.similarity !== null && fact.similarity >= chunk) ? 'fact' : 'chunk';
    return { relevance: verdict, ...(closestFact ? { closestFact } : {}), ...(matchedOn ? { matchedOn } : {}) };
  } catch {
    return null;
  }
}
