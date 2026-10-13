/**
 * Calibration harness for the get_context relevance signal (src/mvp/contextRelevance.ts).
 *
 * Builds each synthetic fixture workspace (fixtures/relevance) deterministically - fixed
 * ledger event ids/timestamps, fixed note times - at two sizes (the workspace alone, and
 * with 120 facts + 30 notes of unrelated memory), indexes it with the embedding provider
 * the hosted product uses (Vertex AI gemini-embedding-001, 768 dims, RENOR_EVAL_VERTEX_*
 * config), asks every calibration question through the product read path
 * (buildAgentContext, the code get_context runs) and records what the product computed.
 * The recorded file is what tests/mvp/context-relevance.test.ts replays, so CI needs no
 * credentials and no network.
 *
 *   set -a; . ~/.config/agent-secrets/.env; set +a
 *   npx tsx scripts/eval/relevance-calibration.ts \
 *     --write fixtures/relevance/recorded.vertex-gemini-embedding-001-768.json
 *   npx tsx scripts/eval/relevance-calibration.ts --from fixtures/relevance/recorded.vertex-gemini-embedding-001-768.json
 *
 * Every text is embedded once: vectors are cached content-addressed in
 * .eval-runs/relevance-embed-cache.db (gitignored, separate from the shared research
 * cache). Synthetic fixture text only. Local embedding models are not used.
 *
 * Gold labels (`expect`, `answer`) live only in the fixture files read here, to score;
 * nothing the product computes can see them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { appendLedgerEvent, replayLedger, DEFAULT_LEDGER_REL } from '../../src/memory/lifecycle';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { VertexEmbeddingProvider } from '../../src/embeddings/vertex';
import { CachingEmbeddingProvider } from '../../src/embeddings/caching';
import { CALIBRATED_BARS, embeddingModelKey, warmFactVectors } from '../../src/mvp/contextRelevance';
import { buildAgentContext } from '../../src/mvp/agentMemory';
import { dailyDirForScope } from '../../src/mvp/scope';
import type { Engine } from '../../src/mvp/engine';
import type { EmbeddingProvider } from '../../src/embeddings/types';

const ENGINE_ROOT = path.resolve(__dirname, '../..');
export const FIXTURES = path.join(ENGINE_ROOT, 'fixtures/relevance');
export const VERTEX_MODEL = 'gemini-embedding-001';
export const VERTEX_DIMS = 768;
export const RECORDED_FILE = path.join(FIXTURES, 'recorded.vertex-gemini-embedding-001-768.json');

export interface FixtureFact { subject: string; predicate: string; object: string; scope?: string }
export interface FixtureNote { slug: string; date: string; text: string }
interface Workspace { facts: FixtureFact[]; notes: FixtureNote[] }

export type Expect = 'answerable' | 'unanswerable';
export type WorkspaceName = 'a' | 'b' | 'c';
export type WorkspaceSize = 'small' | 'large';
export type Split = 'dev' | 'heldout';

const WORKSPACE_FILES: Record<WorkspaceName, string> = { a: 'workspace.json', b: 'workspace.b.json', c: 'workspace.c.json' };
const FIXTURE_FILES = [...Object.values(WORKSPACE_FILES), 'distractors.json', 'questions.dev.json', 'questions.heldout.json'];

export interface CalibrationQuestion {
  id: string;
  /** Which fixture workspace the question is asked against (default 'a'). */
  workspace?: WorkspaceName;
  q: string;
  lang: string;
  category: string;
  expect: Expect;
  /** Any of these appearing in the returned facts/memories means retrieval surfaced the answer. */
  answer?: string[];
}

export interface RecordedResult {
  id: string;
  split: Split;
  workspace: WorkspaceName;
  size: WorkspaceSize;
  /** Best returned-note-chunk cosine (null: no semantic hit). */
  chunk: number | null;
  /** Best current-fact-rendering cosine (null: no facts). */
  fact: number | null;
  /** What the product reported: the two lanes combined, rounded as the response shows it. Null: nothing to compare. */
  similarity: number | null;
  /** The lexical RENOR_READ_HONESTY abstention (the approach #276 removed), on the same question. */
  lexicalAbstained: boolean;
  /** Whether the answer string is anywhere in the returned facts/memories (null for unanswerable). */
  answerInPayload: boolean | null;
}

export interface RecordedCalibration {
  modelKey: string;
  /** sha256 over every fixture file: a changed fixture invalidates the recording. */
  fixtureHash: string;
  /** Indexed chunk count per `<workspace>/<size>`. */
  chunks: Record<string, number>;
  results: RecordedResult[];
}

const round3 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1000) / 1000);

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

export function fixtureHash(): string {
  const h = crypto.createHash('sha256');
  for (const name of [...FIXTURE_FILES].sort()) h.update(`${name}\0${fs.readFileSync(path.join(FIXTURES, name), 'utf8')}\0`);
  return h.digest('hex');
}

export function loadQuestions(split: Split): CalibrationQuestion[] {
  return readJson<{ questions: CalibrationQuestion[] }>(`questions.${split}.json`).questions;
}

export function loadWorkspace(name: WorkspaceName, size: WorkspaceSize): Workspace {
  const base = readJson<Workspace>(WORKSPACE_FILES[name]);
  if (size === 'small') return base;
  const extra = readJson<Workspace>('distractors.json');
  return { facts: [...base.facts, ...extra.facts], notes: [...base.notes, ...extra.notes] };
}

/** Deterministic seed: replays a hand-built ledger and writes the daily notes byte-for-byte. */
export async function seedWorkspace(db: ReturnType<typeof openDb>, memoryDir: string, ws: Workspace): Promise<void> {
  const start = Date.parse('2026-09-01T09:00:00.000Z');
  for (let i = 0; i < ws.facts.length; i++) {
    const f = ws.facts[i];
    await appendLedgerEvent(memoryDir, DEFAULT_LEDGER_REL, {
      id: `MEM_CAL${String(i + 1).padStart(5, '0')}`,
      at: new Date(start + i * 1000).toISOString(),
      kind: 'store',
      subject: f.subject,
      predicate: f.predicate,
      object: f.object,
      closedEvent: null,
      source: 'calibration',
      scope: f.scope ?? 'global',
    });
  }
  await replayLedger(db, memoryDir, DEFAULT_LEDGER_REL);
  const dir = path.join(memoryDir, dailyDirForScope('global'));
  fs.mkdirSync(dir, { recursive: true });
  const taken = new Set<string>();
  for (const n of ws.notes) {
    // One file per note: a note that shares a date with an earlier one (the large variant adds unrelated
    // notes) gets its slug in the name instead of silently overwriting it.
    const file = taken.has(`${n.date}.md`) ? `${n.date}-${n.slug}.md` : `${n.date}.md`;
    taken.add(file);
    fs.writeFileSync(
      path.join(dir, file),
      `---\nkind: note\nupdated: ${n.date}\n---\n# ${n.date}\n\n- [09:00:00] (calibration) ${n.text}`,
      'utf8',
    );
  }
}

/**
 * Fail loudly rather than score a workspace that is not the one the fixtures describe: every fixture fact must
 * be a current fact and every fixture note must be in the index. (A date collision once dropped notes silently.)
 */
export function assertSeeded(db: ReturnType<typeof openDb>, ws: Workspace, label: string): void {
  const current = (db.prepare("SELECT COUNT(*) AS c FROM facts WHERE valid_to IS NULL AND source_path = '_mcp_'").get() as { c: number }).c;
  if (current !== ws.facts.length) throw new Error(`${label}: ${current} current facts for ${ws.facts.length} fixture facts`);
  for (const n of ws.notes) {
    if (!db.prepare('SELECT 1 FROM chunks WHERE instr(text, ?) > 0 LIMIT 1').get(n.text.slice(0, 48))) {
      throw new Error(`${label}: note ${n.slug} (${n.date}) is not in the index`);
    }
  }
}

export interface Confusion {
  /** answerable & called relevant */ tp: number;
  /** answerable & flagged irrelevant - the false abstention */ fn: number;
  /** unanswerable & flagged irrelevant */ tn: number;
  /** unanswerable & called relevant */ fp: number;
  answerable: number;
  unanswerable: number;
  /** fn / answerable */ falseAbstentionRate: number;
  /** tn / unanswerable */ flaggedRate: number;
}

/** A null similarity (nothing to compare) is "no signal", i.e. never flagged: the field stays absent. */
export function confusion(rows: Array<{ expect: Expect; similarity: number | null }>, bar: number): Confusion {
  const c = { tp: 0, fn: 0, tn: 0, fp: 0 };
  for (const r of rows) {
    const flagged = r.similarity !== null && r.similarity < bar;
    if (r.expect === 'answerable') { if (flagged) c.fn++; else c.tp++; }
    else if (flagged) c.tn++;
    else c.fp++;
  }
  const answerable = c.tp + c.fn;
  const unanswerable = c.tn + c.fp;
  return {
    ...c,
    answerable,
    unanswerable,
    falseAbstentionRate: answerable ? c.fn / answerable : 0,
    flaggedRate: unanswerable ? c.tn / unanswerable : 0,
  };
}

/** The bar every shipped default has to clear (captain's spec): false abstentions < 5%, most unanswerable flagged. */
export const FALSE_ABSTENTION_CEILING = 0.05;
export const FLAGGED_FLOOR = 0.5;

export function meetsBar(c: Confusion): boolean {
  return c.falseAbstentionRate < FALSE_ABSTENTION_CEILING && c.flaggedRate > FLAGGED_FLOOR;
}

export type Row = RecordedResult & { expect: Expect; category: string };

export function rowsFor(rec: RecordedCalibration, split: Split, size: WorkspaceSize): Row[] {
  const questions = new Map(loadQuestions(split).map(q => [q.id, q]));
  return rec.results
    .filter(r => r.split === split && r.size === size)
    .map(r => ({ ...r, expect: questions.get(r.id)!.expect, category: questions.get(r.id)!.category }));
}

/**
 * The pre-registered ship criterion: on the held-out split, pooled over its workspaces,
 * BOTH the small and the large run meet the bar.
 */
export function meetsShipCriterion(rec: RecordedCalibration, bar: number): boolean {
  return (['small', 'large'] as WorkspaceSize[]).every(size => meetsBar(confusion(rowsFor(rec, 'heldout', size), bar)));
}

/**
 * The pre-registered bar rule: the midpoint of the 0.01-step bars at which BOTH dev sizes meet the bar.
 * Exact hundredths (an integer loop), not a floating-point accumulation.
 */
export function devBarInterval(rec: RecordedCalibration): { low: number; high: number; midpoint: number } | null {
  const feasible: number[] = [];
  for (let hundredths = 40; hundredths <= 95; hundredths++) {
    const bar = hundredths / 100;
    if ((['small', 'large'] as WorkspaceSize[]).every(size => meetsBar(confusion(rowsFor(rec, 'dev', size), bar)))) feasible.push(bar);
  }
  if (!feasible.length) return null;
  const [low, high] = [feasible[0], feasible[feasible.length - 1]];
  return { low, high, midpoint: (low + high) / 2 };
}

export async function measure(provider: EmbeddingProvider, modelKey: string, splits: Split[]): Promise<RecordedCalibration> {
  const results: RecordedResult[] = [];
  const chunks: Record<string, number> = {};
  const asked = splits.flatMap(split => loadQuestions(split).map(q => ({ split, q })));
  // MIN=0 makes every judged query "relevant": only the similarities the product computed are wanted.
  const env = { RENOR_CONTEXT_RELEVANCE: '1', RENOR_CONTEXT_RELEVANCE_MIN: '0', RENOR_READ_HONESTY: '1' } as NodeJS.ProcessEnv;
  for (const name of ['a', 'b', 'c'] as WorkspaceName[]) {
    const mine = asked.filter(({ q }) => (q.workspace ?? 'a') === name);
    if (mine.length === 0) continue;
    for (const size of ['small', 'large'] as WorkspaceSize[]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `relevance-${name}-${size}-`));
      try {
        const memoryDir = path.join(root, 'memory');
        fs.mkdirSync(memoryDir);
        const db = openDb(path.join(root, 'index.db'));
        runMigrations(db);
        const vectorIndex = new VectorIndex(db, provider.dimensions);
        vectorIndex.initTable();
        const ws = loadWorkspace(name, size);
        await seedWorkspace(db, memoryDir, ws);
        await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 4);
        assertSeeded(db, ws, `${name}/${size}`);
        chunks[`${name}/${size}`] = (db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c;
        const engine: Engine = { provider, vectorIndex, dims: provider.dimensions, modelKey };
        // The product embeds fact renderings in the background; the calibration waits for them.
        if (!await warmFactVectors(db, provider)) throw new Error('fact vectors did not warm');
        for (const { split, q } of mine) {
          const components: { chunk: number | null; fact: number | null } = { chunk: null, fact: null };
          const body = await buildAgentContext(db, engine, memoryDir, { query: q.q, env, relevanceComponents: components }) as {
            facts: unknown[]; memories: Array<{ text: string }>; relevance?: { similarity: number }; abstention?: unknown;
          };
          const payload = `${JSON.stringify(body.facts)} ${body.memories.map(m => m.text).join(' ')}`.toLowerCase();
          results.push({
            id: q.id,
            split,
            workspace: name,
            size,
            chunk: round3(components.chunk),
            fact: round3(components.fact),
            similarity: body.relevance?.similarity ?? null,
            lexicalAbstained: Boolean(body.abstention),
            answerInPayload: q.answer ? q.answer.some(a => payload.includes(a.toLowerCase())) : null,
          });
        }
        db.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
  return { modelKey, fixtureHash: fixtureHash(), chunks, results };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** P(an answerable question scores above an unanswerable one); ties count half. Null scores as -1. */
export function auc(rows: Row[], score: (r: Row) => number | null): number {
  const pos = rows.filter(r => r.expect === 'answerable').map(r => score(r) ?? -1);
  const neg = rows.filter(r => r.expect === 'unanswerable').map(r => score(r) ?? -1);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return pos.length && neg.length ? wins / (pos.length * neg.length) : 0;
}

function matrixLine(label: string, c: Confusion): string {
  return `${label.padEnd(22)} answerable ${String(c.answerable).padStart(3)}: relevant ${String(c.tp).padStart(3)} false-abstain ${String(c.fn).padStart(2)} (${pct(c.falseAbstentionRate).padStart(5)})`
    + `   unanswerable ${String(c.unanswerable).padStart(3)}: flagged ${String(c.tn).padStart(3)} (${pct(c.flaggedRate).padStart(5)}) missed ${String(c.fp).padStart(2)}`
    + `   ${meetsBar(c) ? 'MEETS BAR' : 'misses bar'}`;
}

/** Same questions through the lexical RENOR_READ_HONESTY abstention: its false-abstain / flagged rates. */
export function lexicalConfusion(rows: Row[]): Confusion {
  return confusion(rows.map(r => ({ expect: r.expect, similarity: r.lexicalAbstained ? -1 : 1 })), 0);
}

export function report(rec: RecordedCalibration, bar: number): string {
  const splits = (['dev', 'heldout'] as Split[]).filter(split => rec.results.some(r => r.split === split));
  const lines: string[] = [`model ${rec.modelKey}  bar ${bar}  chunks ${JSON.stringify(rec.chunks)}  fixtures ${rec.fixtureHash.slice(0, 12)}`];
  for (const split of splits) {
    for (const size of ['small', 'large'] as WorkspaceSize[]) {
      const rows = rowsFor(rec, split, size);
      if (!rows.length) continue;
      lines.push('', `== ${split}/${size}`);
      lines.push(matrixLine('similarity signal', confusion(rows, bar)));
      lines.push(matrixLine('lexical honesty (ref.)', lexicalConfusion(rows)));
      lines.push(`  AUC (answerable above unanswerable): chunk lane ${auc(rows, r => r.chunk).toFixed(3)}  fact lane ${auc(rows, r => r.fact).toFixed(3)}  combined ${auc(rows, r => r.similarity).toFixed(3)}`);
      for (const ws of ['a', 'b', 'c'] as WorkspaceName[]) {
        const mine = rows.filter(r => r.workspace === ws);
        if (mine.length) lines.push(matrixLine(`  workspace ${ws}`, confusion(mine, bar)));
      }
      // A category can hold both kinds (e.g. long requests that are and are not on file): report each kind.
      const byCategory = new Map<string, Row[]>();
      for (const r of rows) byCategory.set(`${r.category}|${r.expect}`, [...(byCategory.get(`${r.category}|${r.expect}`) ?? []), r]);
      for (const [key, rs] of byCategory) {
        const c = confusion(rs, bar);
        const answerable = rs[0].expect === 'answerable';
        lines.push(`    ${key.split('|')[0].padEnd(20)} n=${String(rs.length).padStart(2)}  ${answerable ? `false-abstain ${c.fn}` : `flagged ${c.tn}, missed ${c.fp}`}`);
      }
      const answerable = rows.filter(r => r.expect === 'answerable');
      lines.push(`    answer absent from the returned payload (a retrieval miss, separate from the signal): ${answerable.filter(r => r.answerInPayload === false).length}/${answerable.length}`);
    }
  }
  if (splits.includes('heldout')) lines.push('', `ship criterion (held-out, both sizes, FA < 5% and flagged > 50%): ${meetsShipCriterion(rec, bar) ? 'MET' : 'NOT MET'}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const program = new Command()
    .name('relevance-calibration')
    .option('--splits <list>', 'comma separated: dev,heldout', 'dev,heldout')
    .option('--bar <n>', 'bar to report against (default: the shipped bar for the model)')
    .option('--cache <file>', 'persistent embedding cache', path.join(ENGINE_ROOT, '.eval-runs/relevance-embed-cache.db'))
    .option('--from <file>', 'report from a recorded file instead of measuring (no credentials, no network)')
    .option('--write <file>', 'write the recorded results to this file');
  program.parse();
  const opts = program.opts<{ splits: string; bar?: string; cache: string; from?: string; write?: string }>();
  const modelKey = embeddingModelKey('vertex', VERTEX_MODEL, VERTEX_DIMS);
  const bar = opts.bar !== undefined ? Number(opts.bar) : CALIBRATED_BARS[modelKey];
  if (opts.from) {
    const rec = JSON.parse(fs.readFileSync(opts.from, 'utf8')) as RecordedCalibration;
    if (rec.fixtureHash !== fixtureHash()) console.log('WARNING: fixtures changed since this file was recorded');
    console.log(report(rec, bar));
    return;
  }
  const vertex = new VertexEmbeddingProvider({ model: VERTEX_MODEL, dimensions: VERTEX_DIMS });
  // Keyed by the identity the provider declares (vertex/gemini-embedding-001/768), so no label is typed here.
  const provider = new CachingEmbeddingProvider(vertex, { cachePath: opts.cache });
  try {
    const rec = await measure(provider, modelKey, opts.splits.split(',') as Split[]);
    console.log(report(rec, bar));
    console.log(`\nembeddings: cache hits ${provider.stats.hits}, misses ${provider.stats.misses}, vertex input tokens ${vertex.usage.inputTokens}`);
    if (opts.write) fs.writeFileSync(opts.write, `${JSON.stringify(rec, null, 1)}\n`);
  } finally {
    provider.close();
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
