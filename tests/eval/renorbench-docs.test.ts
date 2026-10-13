import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DOCS_CASES_PATH, DOCS_FIXTURE_DIR, buildRenorBenchDocs } from '../../scripts/eval/generate-renorbench-docs';
import { hashFixture, sha256Buffer } from '../../scripts/eval/renorbench-common';
import { HASH_RELEVANCE_BAR } from '../../src/eval/renorbenchProduct';
import { DOCUMENTS_BENCHMARK, DOCUMENTS_CONTEXT_MAX_TOKENS } from '../../src/eval/renorbenchDocuments';
import type { EvalCase } from '../../src/eval/scoring';
import { chunkNote } from '../../src/indexer/chunker';
import { parseNote } from '../../src/indexer/parser';
import { SESSION_EXPAND_DOCUMENT_MAX_CHUNK_TOKENS, SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';

/**
 * RenorBench's documents arm exists because v1 and v2 hold no document: a flat 100-token cap on the session expansion's
 * statements removed 186 of the 309 answer-bearing statements it delivered on a vault of documents and moved no gated number.
 * The first half of this file pins the fixture as data (it is what the generator writes; each case's evidence is where the
 * case says, in a section the chunker cuts whole, of the size its category says); the second runs the real product arm over it
 * and pins what the fixture is FOR: the section next to a match is delivered by the session expansion and by nothing else,
 * the control is delivered whatever the expansion does, and the run is free.
 */

const ENGINE_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(ENGINE_ROOT, DOCS_FIXTURE_DIR);
const VAULT_DIR = path.join(FIXTURE_DIR, 'vault');
const CASES_PATH = path.join(ENGINE_ROOT, DOCS_CASES_PATH);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [path.relative(VAULT_DIR, full).replaceAll(path.sep, '/')];
  });
}

const cases: EvalCase[] = fs.readFileSync(CASES_PATH, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as EvalCase);
const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'fixture.json'), 'utf8')) as { version: number; relativeMtimeDays: Record<string, number>; deleteAfterIndex?: string[] };
const BANDS: Record<string, [number, number]> = { 'adjacent-le100': [20, 100], 'adjacent-101-200': [101, 200], 'adjacent-201-400': [201, 400] };

/** The whole-section chunk of a case's note that holds its needle. */
function probedChunk(test: EvalCase) {
  const target = test.relevant[0];
  const note = parseNote(target.notePath!, fs.readFileSync(path.join(VAULT_DIR, target.notePath!), 'utf8'));
  const chunks = chunkNote(note);
  const holding = chunks.filter(chunk => chunk.text.toLowerCase().includes(target.match.toLowerCase()));
  return { chunks, holding };
}

describe('RenorBench documents as data', () => {
  it('is exactly what the generator writes: the fixture, every note and the cases, byte for byte', () => {
    const built = buildRenorBenchDocs();
    expect(fs.readFileSync(path.join(FIXTURE_DIR, 'fixture.json'), 'utf8')).toBe(built.fixtureJson);
    expect(fs.readFileSync(CASES_PATH, 'utf8')).toBe(built.casesJsonl);
    expect(walk(VAULT_DIR).sort()).toEqual([...built.notes.keys()].sort());
    for (const [notePath, text] of built.notes) expect(fs.readFileSync(path.join(VAULT_DIR, notePath), 'utf8'), notePath).toBe(text);
  });

  it('writes the same bytes twice: nothing in it reads a clock, the environment or a random source', () => {
    const first = buildRenorBenchDocs();
    const second = buildRenorBenchDocs();
    expect(second.casesJsonl).toBe(first.casesJsonl);
    expect(second.fixtureJson).toBe(first.fixtureJson);
    expect([...second.notes]).toEqual([...first.notes]);
  });

  it('is forty notes and 120 cases: three questions for each of forty probed sections, eight per size stratum', () => {
    expect(walk(VAULT_DIR).length).toBe(40);
    expect(cases.length).toBe(120);
    expect(new Set(cases.map(test => test.id)).size).toBe(cases.length);
    const counts = new Map<string, number>();
    for (const test of cases) counts.set(test.category, (counts.get(test.category) ?? 0) + 1);
    expect(Object.fromEntries([...counts].sort())).toEqual({ 'adjacent-101-200': 32, 'adjacent-201-400': 16, 'adjacent-le100': 32, direct: 40 });
    expect(cases.filter(test => test.id.endsWith('-parent')).length).toBe(40);
    expect(cases.filter(test => test.id.endsWith('-neighbor')).length).toBe(40);
    expect(cases.filter(test => test.id.endsWith('-direct')).length).toBe(40);
    expect(cases.every(test => test.split === 'dev')).toBe(true);
  });

  it('gives every note an age, and no age to a note that is not there', () => {
    expect(meta.version).toBe(1);
    expect(meta.deleteAfterIndex).toBeUndefined();
    expect(Object.keys(meta.relativeMtimeDays).sort()).toEqual(walk(VAULT_DIR).sort());
    for (const [notePath, age] of Object.entries(meta.relativeMtimeDays)) expect(Number.isInteger(age) && age >= 30, `${notePath}: older than the 30 days the recency boost covers`).toBe(true);
  });

  it('pins every case to one section that holds its needle, once in the whole vault, and no question holds it', () => {
    const everything = walk(VAULT_DIR).map(note => fs.readFileSync(path.join(VAULT_DIR, note), 'utf8')).join('\n').toLowerCase();
    for (const test of cases) {
      expect(test.relevant.length, test.id).toBe(1);
      const needle = test.relevant[0].match.toLowerCase();
      expect(test.relevant[0].notePath, `${test.id} must be path-pinned`).toBeDefined();
      expect(everything.split(needle).length - 1, `${test.id}: "${needle}" must occur once in the vault`).toBe(1);
      expect(test.query.toLowerCase().includes(needle), `${test.id}: the question holds its needle`).toBe(false);
    }
  });

  it('writes each probed section as a whole-section statement of the size its category says, the control in the same section as its pair', () => {
    for (const test of cases) {
      const { chunks, holding } = probedChunk(test);
      expect(holding.length, test.id).toBe(1);
      const [section] = holding;
      // What sessionExpansionHits asks of a statement: a whole section (no other chunk of the note shares its heading
      // path) of at most SESSION_EXPAND_DOCUMENT_MAX_CHUNK_TOKENS tokens. The 201-400 band is the one that cannot be.
      expect(chunks.filter(chunk => chunk.headingPath === section.headingPath).length, `${test.id} shares a heading path`).toBe(1);
      if (test.category === 'direct') {
        expect(section.tokenCount, test.id).toBeGreaterThanOrEqual(20);
      } else {
        const [lo, hi] = BANDS[test.category];
        expect(section.tokenCount, `${test.id} ${test.category}`).toBeGreaterThanOrEqual(lo);
        expect(section.tokenCount, `${test.id} ${test.category}`).toBeLessThanOrEqual(hi);
        expect(section.tokenCount <= SESSION_EXPAND_DOCUMENT_MAX_CHUNK_TOKENS, `${test.id}: a statement only below the expansion's limit`).toBe(test.category !== 'adjacent-201-400');
      }
    }
    // A control and the two questions of its section share a section.
    for (let i = 0; i < cases.length; i += 3) {
      expect(cases[i + 2].category).toBe('direct');
      expect(cases[i].relevant[0].match).toBe(cases[i + 2].relevant[0].match);
      expect(cases[i + 1].relevant[0].match).toBe(cases[i + 2].relevant[0].match);
    }
  });

  it('gives every heading of a note once, so that every section is a statement the expansion could add', () => {
    for (const notePath of walk(VAULT_DIR)) {
      const chunks = chunkNote(parseNote(notePath, fs.readFileSync(path.join(VAULT_DIR, notePath), 'utf8')));
      const paths = chunks.map(chunk => chunk.headingPath);
      expect(new Set(paths).size, notePath).toBe(paths.length);
    }
  });

  it('sizes the whole sections of the vault like a real document vault: within five points of each measured share', () => {
    const bounds = [60, 100, 150, 200, 400];
    const measured = [0.216, 0.145, 0.193, 0.15, 0.292];
    const counts = [0, 0, 0, 0, 0];
    let total = 0;
    for (const notePath of walk(VAULT_DIR)) {
      for (const chunk of chunkNote(parseNote(notePath, fs.readFileSync(path.join(VAULT_DIR, notePath), 'utf8')))) {
        if (chunk.headingPath.split(' > ').length < 2) continue; // the title alone is no section
        total += 1;
        counts[bounds.findIndex(bound => chunk.tokenCount <= bound)] += 1;
      }
    }
    expect(total).toBeGreaterThanOrEqual(250);
    counts.forEach((count, i) => expect(Math.abs(count / total - measured[i]), `stratum ${i}`).toBeLessThanOrEqual(0.05));
  });

  it('asks the parent question with the title of the note, and the neighbour question with the section before the probed one', () => {
    for (const test of cases.filter(candidate => candidate.id.endsWith('-parent'))) {
      const note = parseNote(test.relevant[0].notePath!, fs.readFileSync(path.join(VAULT_DIR, test.relevant[0].notePath!), 'utf8'));
      expect(test.query, test.id).toBe(note.title);
    }
    for (const test of cases.filter(candidate => candidate.id.endsWith('-neighbor'))) {
      const { chunks, holding } = probedChunk(test);
      const before = chunks[chunks.indexOf(holding[0]) - 1];
      expect(before, `${test.id}: the probed section is never the first`).toBeDefined();
      const firstWord = test.query.split(' ')[0];
      expect(before.text.includes(firstWord), test.id).toBe(true);
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

/** The runner as a child process with a whitelisted environment, on the documents suite. */
function run(...args: string[]): Promise<Run> {
  const dir = path.join(workDir, `run-${counter++}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', RUNNER, '--suite', 'documents', '--allow-dirty', '--output', dir, ...args], { cwd: ENGINE_ROOT, env: BASE_ENV });
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
const holdingNeedle = (hits: Hit[], test: EvalCase): Hit | undefined =>
  hits.find(hit => hit.notePath === test.relevant[0].notePath && hit.text.toLowerCase().includes(test.relevant[0].match.toLowerCase()));

describe('RenorBench documents through the product arm', () => {
  let defaults: Run;
  let noExpansion: Run;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renorbench-docs-'));
    defaults = await run();
    noExpansion = await run('--env', 'RENOR_SESSION_EXPAND=0');
  }, 2 * PER_RUN_TIMEOUT_MS);

  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it('runs the committed suite, free, and names it infrastructure', async () => {
    expect(defaults.status, defaults.stderr.slice(0, 600)).toBe(0);
    expect(defaults.manifest).toMatchObject({
      benchmark: DOCUMENTS_BENCHMARK,
      arm: 'product',
      qualityEligible: false,
      provider: { kind: 'hash', qualityEligible: false },
      caseCount: cases.length,
      casesPath: DOCS_CASES_PATH,
      fixturePath: DOCS_FIXTURE_DIR,
      network: { blockedFetchCalls: 0, guarded: true },
      productMode: { overrides: [], relevanceBar: { value: HASH_RELEVANCE_BAR } },
      entryPoint: { searchTool: 'search_memory', contextTool: 'get_context', contextArguments: expect.stringContaining(`max_tokens=${DOCUMENTS_CONTEXT_MAX_TOKENS}`) },
    });
    expect(defaults.manifest.warning).toContain('MUST NOT be reported as a Renor quality score');
    expect(defaults.manifest.casesSha256).toBe(sha256Buffer(fs.readFileSync(CASES_PATH)));
    expect(defaults.manifest.fixtureSha256).toBe(await hashFixture(FIXTURE_DIR));
    expect(defaults.manifest.ambientEnvIgnored).toEqual([]);
    expect(defaults.results.size).toBe(cases.length);
    expect(defaults.summary.documentsPath.replyTokens.contextP95).toBeLessThanOrEqual(DOCUMENTS_CONTEXT_MAX_TOKENS);
  });

  it('delivers the control every time, with the expansion and without it: a statement the query itself finds needs no limit', () => {
    for (const test of cases.filter(candidate => candidate.category === 'direct')) {
      const hit = holdingNeedle(defaults.results.get(test.id)!.hits, test);
      expect(hit, `${test.id}: the section itself must be in the reply`).toBeDefined();
      expect(hit!.reason, `${test.id}: ... as a match, not as an added statement`).not.toBe(SESSION_EXPAND_REASON);
      expect(holdingNeedle(noExpansion.results.get(test.id)!.hits, test), test.id).toBeDefined();
    }
    expect(defaults.summary.byCategory.direct.directDelivered).toBe(1);
    expect(noExpansion.summary.byCategory.direct.directDelivered).toBe(1);
  });

  it('delivers the section next to a match mostly through the session expansion, and mostly loses it with the expansion off', () => {
    for (const band of ['adjacent-le100', 'adjacent-101-200']) {
      expect(defaults.summary.byCategory[band].adjacentDelivered, band).toBeGreaterThanOrEqual(0.7);
      expect(noExpansion.summary.byCategory[band].adjacentDelivered, band).toBeLessThanOrEqual(0.25);
    }
    // What the expansion delivers, it delivers as a statement it added; nothing else brings a section the window lacks.
    const added = cases.filter(test => test.category !== 'direct' && test.category !== 'adjacent-201-400')
      .filter(test => holdingNeedle(defaults.results.get(test.id)!.hits, test) && !holdingNeedle(noExpansion.results.get(test.id)!.hits, test));
    expect(added.length).toBeGreaterThanOrEqual(40);
    for (const test of added) expect(holdingNeedle(defaults.results.get(test.id)!.hits, test)!.reason, test.id).toBe(SESSION_EXPAND_REASON);
  });

  it('keeps the 101-200 band at the edge of the cliff: its sections are statements, and a section above 200 tokens never is', () => {
    // 201-400 sections are not statements (over the limit): the expansion adds none, so the off arm delivers exactly what the
    // window did, and it is the same with the expansion on.
    expect(defaults.summary.byCategory['adjacent-201-400'].adjacentDelivered).toBe(noExpansion.summary.byCategory['adjacent-201-400'].adjacentDelivered);
    for (const test of cases.filter(candidate => candidate.category === 'adjacent-201-400')) {
      const hit = holdingNeedle(defaults.results.get(test.id)!.hits, test);
      if (hit) expect(hit.reason, test.id).not.toBe(SESSION_EXPAND_REASON);
    }
  });

  it('reads every case through get_context at 800 tokens too, and the expansion reaches it only with what the matches leave', () => {
    expect(defaults.summary.overall.contextDelivered).toBeGreaterThan(0);
    for (const row of defaults.results.values()) expect(row.context.replyTokens, row.id).toBeLessThanOrEqual(DOCUMENTS_CONTEXT_MAX_TOKENS);
    expect(defaults.summary.documentsPath.contextExpandReplies).toBeLessThan(defaults.summary.documentsPath.sessionExpandReplies);
  });
});
