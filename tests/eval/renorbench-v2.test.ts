import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { V2_CASES_PATH, V2_FIXTURE_DIR, buildRenorBenchV2 } from '../../scripts/eval/generate-renorbench-v2';
import { hashFixture, sha256Buffer } from '../../scripts/eval/renorbench-common';
import { HASH_RELEVANCE_BAR } from '../../src/eval/renorbenchProduct';
import { roleOf, type GoldTarget } from '../../src/eval/metrics';
import type { EvalCase } from '../../src/eval/scoring';
import { chunkNote } from '../../src/indexer/chunker';
import { parseNote } from '../../src/indexer/parser';
import { SESSION_EXPAND_MAX_CHUNK_TOKENS } from '../../src/retrieval/orchestrator';

/**
 * RenorBench v2 exists because v1 is too small to show three product features: session expansion, the newest-value
 * rules and the relevance verdict. The first half of this file pins the fixture as data (it is what the generator
 * writes, and each case's evidence is where the case says); the second runs the real product arm over it and pins what the
 * fixture is FOR: the remark of a chat is delivered by the expansion and by nothing else, the newest value comes first
 * by the layout and stays in the window by the recency boost, and the verdict separates the two kinds of question.
 */

const ENGINE_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(ENGINE_ROOT, V2_FIXTURE_DIR);
const VAULT_DIR = path.join(FIXTURE_DIR, 'vault');
const CASES_PATH = path.join(ENGINE_ROOT, V2_CASES_PATH);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [path.relative(VAULT_DIR, full).replaceAll(path.sep, '/')];
  });
}

const cases: EvalCase[] = fs.readFileSync(CASES_PATH, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as EvalCase);
const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'fixture.json'), 'utf8')) as { version: number; relativeMtimeDays: Record<string, number>; deleteAfterIndex?: string[] };
const allTargets = (test: EvalCase): GoldTarget[] => [...test.relevant, ...(test.requiredEvidence ?? []), ...(test.forbiddenEvidence ?? [])];
const bySuffix = (prefix: string) => cases.filter(test => test.id.startsWith(prefix));

describe('RenorBench v2 as data', () => {
  it('is exactly what the generator writes: the fixture, every note and the cases, byte for byte', () => {
    const built = buildRenorBenchV2();
    expect(fs.readFileSync(path.join(FIXTURE_DIR, 'fixture.json'), 'utf8')).toBe(built.fixtureJson);
    expect(fs.readFileSync(CASES_PATH, 'utf8')).toBe(built.casesJsonl);
    expect(walk(VAULT_DIR).sort()).toEqual([...built.notes.keys()].sort());
    for (const [notePath, text] of built.notes) expect(fs.readFileSync(path.join(VAULT_DIR, notePath), 'utf8'), notePath).toBe(text);
  });

  it('writes the same bytes twice: nothing in it reads a clock, the environment or a random source', () => {
    const first = buildRenorBenchV2();
    const second = buildRenorBenchV2();
    expect(second.casesJsonl).toBe(first.casesJsonl);
    expect(second.fixtureJson).toBe(first.fixtureJson);
    expect([...second.notes]).toEqual([...first.notes]);
  });

  it('has unique case ids and a floor for every category', () => {
    expect(new Set(cases.map(test => test.id)).size).toBe(cases.length);
    const counts = new Map<string, number>();
    for (const test of cases) counts.set(test.category, (counts.get(test.category) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual(['abstention', 'knowledge_update', 'session_detail']);
    expect(counts.get('session_detail')).toBeGreaterThanOrEqual(40);
    expect(counts.get('knowledge_update')).toBeGreaterThanOrEqual(24);
    expect(counts.get('abstention')).toBeGreaterThanOrEqual(20);
    expect(cases.every(test => test.split === 'dev')).toBe(true);
  });

  it('pins every gold target to a note of the vault that says it, and the evidence of a case occurs in one place only', () => {
    const everything = walk(VAULT_DIR).map(note => fs.readFileSync(path.join(VAULT_DIR, note), 'utf8')).join('\n').toLowerCase();
    for (const test of cases) {
      for (const target of allTargets(test)) {
        expect(target.notePath, `${test.id} target "${target.match}" must be path-pinned`).toBeDefined();
        const text = fs.readFileSync(path.join(VAULT_DIR, target.notePath!), 'utf8').toLowerCase();
        expect(text, `${test.id}: "${target.match}" is not in ${target.notePath}`).toContain(target.match.toLowerCase());
        expect(everything.split(target.match.toLowerCase()).length - 1, `${test.id}: "${target.match}" must occur once in the vault`).toBe(1);
      }
    }
  });

  it('gives a stale value its own note, and every answerable case a positive target', () => {
    for (const test of cases) {
      if (test.shouldAbstain || test.relevant.length === 0) continue;
      const positive = test.relevant.filter(target => roleOf(target) === 'positive');
      expect(positive.length, `${test.id} has no creditable gold`).toBeGreaterThan(0);
      const positivePaths = new Set(positive.map(target => target.notePath));
      for (const target of test.relevant.filter(candidate => roleOf(candidate) === 'forbidden')) {
        expect(positivePaths.has(target.notePath), `${test.id} forbids a value that lives in the note of its answer`).toBe(false);
      }
    }
    for (const test of bySuffix('update-')) {
      expect(test.relevant.filter(target => roleOf(target) === 'forbidden').length, test.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('asks about the present, never in a word of past intent, which would reorder the reply to best-match-first', () => {
    for (const test of cases) expect(test.query, test.id).not.toMatch(/\b(previously|before|used to|former|formerly|earlier|in the past|history)\b/i);
  });

  it('gives every note an age, and no age to a note that is not there', () => {
    expect(meta.version).toBe(2);
    expect(meta.deleteAfterIndex).toBeUndefined();
    expect(Object.keys(meta.relativeMtimeDays).sort()).toEqual(walk(VAULT_DIR).sort());
    for (const [notePath, age] of Object.entries(meta.relativeMtimeDays)) expect(Number.isInteger(age) && age >= 0, notePath).toBe(true);
  });

  it('writes each turn of a chat as one section: a remark is a statement the expansion may add, an answer is not', () => {
    for (const test of bySuffix('detail-')) {
      const target = test.relevant[0];
      const note = parseNote(target.notePath!, fs.readFileSync(path.join(VAULT_DIR, target.notePath!), 'utf8'));
      const chunks = chunkNote(note);
      const holding = chunks.filter(chunk => chunk.text.toLowerCase().includes(target.match.toLowerCase()));
      expect(holding.length, test.id).toBe(1);
      const [remark] = holding;
      // What sessionExpansionHits asks of a statement: a whole section (no other chunk of the note shares its heading
      // path) of at most SESSION_EXPAND_MAX_CHUNK_TOKENS tokens.
      expect(remark.tokenCount, `${test.id} remark`).toBeLessThanOrEqual(SESSION_EXPAND_MAX_CHUNK_TOKENS);
      expect(chunks.filter(chunk => chunk.headingPath === remark.headingPath).length, `${test.id} remark shares a heading path`).toBe(1);
      const answers = chunks.filter(chunk => /^### Turn \d+ - Assistant\n\n[^\n]{800,}/.test(chunk.text));
      expect(answers.length, `${test.id} answers`).toBeGreaterThanOrEqual(12);
      for (const answer of answers) expect(answer.tokenCount, `${test.id} ${answer.headingPath}`).toBeGreaterThan(SESSION_EXPAND_MAX_CHUNK_TOKENS);
    }
  });
});

const PER_RUN_TIMEOUT_MS = 180_000;
const RUNNER = 'scripts/eval/run-renorbench-product.ts';
const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
};

interface Run {
  status: number | null;
  stderr: string;
  manifest: Record<string, any>;
  summary: Record<string, any>;
  results: Map<string, Record<string, any>>;
}

let workDir: string;
let counter = 0;

/** The runner as a child process with a whitelisted environment, on the v2 suite. */
function run(...args: string[]): Promise<Run> {
  const dir = path.join(workDir, `run-${counter++}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', RUNNER, '--suite', 'v2', '--allow-dirty', '--output', dir, ...args], { cwd: ENGINE_ROOT, env: BASE_ENV });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      const read = (file: string) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '');
      resolve({
        status, stderr,
        manifest: read('manifest.json') ? JSON.parse(read('manifest.json')) : {},
        summary: read('summary.json') ? JSON.parse(read('summary.json')) : {},
        results: new Map(read('results.jsonl').split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return [row.id, row] as const; })),
      });
    });
  });
}

type Hit = { notePath: string; text: string; reason?: string };
const holding = (row: Record<string, any>, target: GoldTarget): Hit | undefined =>
  (row.hits as Hit[]).find(hit => hit.notePath === target.notePath && hit.text.toLowerCase().includes(target.match.toLowerCase()));

describe('RenorBench v2 through the product arm', () => {
  let defaults: Run;
  let noExpansion: Run;
  let layoutByScore: Run;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renorbench-v2-'));
    defaults = await run();
    noExpansion = await run('--env', 'RENOR_SESSION_EXPAND=0');
    layoutByScore = await run('--env', 'RENOR_NEWEST_FIRST=0');
  }, 3 * PER_RUN_TIMEOUT_MS);

  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it('runs the committed suite, free, and names it', async () => {
    expect(defaults.status, defaults.stderr.slice(0, 600)).toBe(0);
    expect(defaults.manifest).toMatchObject({
      benchmark: 'renorbench-v2-product',
      arm: 'product',
      qualityEligible: false,
      caseCount: cases.length,
      casesPath: V2_CASES_PATH,
      fixturePath: V2_FIXTURE_DIR,
      network: { blockedFetchCalls: 0, guarded: true },
      productMode: { overrides: [], relevanceBar: { value: HASH_RELEVANCE_BAR } },
    });
    expect(defaults.manifest.casesSha256).toBe(sha256Buffer(fs.readFileSync(CASES_PATH)));
    expect(defaults.manifest.fixtureSha256).toBe(await hashFixture(FIXTURE_DIR));
    expect(defaults.manifest.ambientEnvIgnored).toEqual([]);
    expect(defaults.results.size).toBe(cases.length);
  });

  it('delivers the remark of a chat only through the session expansion, and loses it with the expansion off', () => {
    const detail = bySuffix('detail-');
    expect(detail.length).toBeGreaterThanOrEqual(40);
    for (const test of detail) {
      // The reader layout (readerLayout.ts) joins the statements the expansion added to the chunks of their chat, in the chat's order and under the best
      // chunk's reason, so the remark is in the reply but no longer labelled as the expansion's. That the expansion alone put it there is the next line.
      expect(holding(defaults.results.get(test.id)!, test.relevant[0]), `${test.id}: the remark must be in the reply`).toBeDefined();
      expect(holding(noExpansion.results.get(test.id)!, test.relevant[0]), `${test.id}: no remark may be in the window`).toBeUndefined();
    }
    expect(defaults.summary.byCategory.session_detail).toMatchObject({ replyRecall: 1, replyRecallAll: 1 });
    expect(noExpansion.summary.byCategory.session_detail).toMatchObject({ replyRecall: 0, replyRecallAll: 0 });
    // Nothing else moves but what the reply costs: the other categories deliver the same, and judge the same.
    expect(noExpansion.summary.byCategory.knowledge_update.replyRecall).toBe(1);
    for (const name of ['verdictRelevantRate', 'verdictAbstainRate'] as const) expect(noExpansion.summary.overall[name]).toBe(defaults.summary.overall[name]);
    expect(noExpansion.summary.overall.meanReplyTokens).toBeLessThan(defaults.summary.overall.meanReplyTokens);
  });

  it('puts the newest value first by the layout, and a stale one first when the layout is by score', () => {
    expect(defaults.summary.byCategory.knowledge_update).toMatchObject({ replyRecall: 1, replyRecallAll: 1, contradictionFirstRate: 0, supersessionSensitiveCases: 27 });
    expect(layoutByScore.summary.byCategory.knowledge_update.replyRecall).toBe(1);
    expect(layoutByScore.summary.byCategory.knowledge_update.contradictionFirstRate).toBeGreaterThanOrEqual(0.25);
    expect(layoutByScore.summary.byCategory.session_detail.replyRecall).toBe(1);
  });

  it('keeps the newest entry of a log in the window by the recency boost, which nothing but a note under thirty days old gets', () => {
    for (const test of bySuffix('update-log-')) {
      const newest = holding(defaults.results.get(test.id)!, test.relevant.find(target => roleOf(target) === 'positive')!);
      expect(newest, `${test.id}: the newest entry must be in the reply`).toBeDefined();
      expect(newest!.reason, `${test.id}: ... and in it by the recency boost`).toContain('+recency');
    }
  });

  it('separates the questions the vault can answer from the ones it cannot, with room either side of the bar', () => {
    for (const test of cases) {
      const verdict = defaults.results.get(test.id)!.verdict as { relevant: boolean; similarity: number; bar: number };
      if (test.shouldAbstain) {
        expect(verdict.relevant, `${test.id} (${test.query})`).toBe(false);
        expect(verdict.similarity, test.id).toBeLessThanOrEqual(HASH_RELEVANCE_BAR - 0.05);
      } else {
        expect(verdict.relevant, `${test.id} (${test.query})`).toBe(true);
        expect(verdict.similarity, test.id).toBeGreaterThanOrEqual(HASH_RELEVANCE_BAR + 0.04);
      }
    }
    expect(defaults.summary.overall).toMatchObject({ verdictRelevantRate: 1, verdictAbstainRate: 1, forbiddenInReplyRate: null });
  });
});
