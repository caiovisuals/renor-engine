import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  caseEvidence,
  cliPublicSearch,
  evidenceCoverage,
  productRunConfig,
  runProductBenchmark,
  type ProductHooks,
  type ProductQaCase,
  type ProductRunnerOptions,
} from '../../scripts/eval/run-longmemeval-product';
import { productFeatureFlagOverrides } from '../../src/eval/runManifest';
import { runFingerprint } from '../../src/eval/runLedger';
import { EVIDENCE_PROVIDER_ENV, startStubChat, type StubChat } from '../helpers/stubChat';

/**
 * Issue #222, part 2: the run manifest says what the evidence layer did on every case.
 *
 * Measured 2026-09-30: an evidence key pool emptied after 423 of 500 cases, the product's
 * deliberately fail-open search answered the last 77 cases without the evidence table, and
 * the manifest reported full coverage with no evidence field at all, so a mixed-mode 428/500
 * was written down as a score. The 2026-10-03 extractor study lost 5 of 29 `glm-5p3`
 * searches the same way. The runner now records the public surface's own evidence report
 * per case, and the manifest (and the score report) carry the counts and the failed ids.
 */

const REPO_ROOT = process.cwd();
// The end-to-end case spawns the product CLI (index + search) and the scorer through tsx.
const SPAWN_BUDGET_MS = 180_000;

interface Row {
  question_id: string; question_type: string; question: string; answer: string;
  question_date: string; haystack_session_ids: string[]; haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>; answer_session_ids: string[];
}

function row(id: string, question: string): Row {
  return {
    question_id: id,
    question_type: 'multi-session',
    question,
    answer: '3 days',
    question_date: '2026/02/01 (Sun) 09:00',
    haystack_session_ids: [`${id}-s1`],
    haystack_dates: ['2026/01/01 (Thu) 10:00'],
    haystack_sessions: [[{ role: 'user', content: 'We went camping for 3 days near the lake.' }, { role: 'assistant', content: 'Noted.' }]],
    answer_session_ids: [`${id}-s1`],
  };
}

const stubModels: ProductHooks['models'] = {
  async modelCall(callType) {
    return callType === 'answer'
      ? { rawContent: '3 days', modelEcho: 'stub-answer', finishReason: 'stop', promptTokens: 10, completionTokens: 2, latencyMs: 1 }
      : { rawContent: '1', modelEcho: 'stub-judge', finishReason: 'stop', promptTokens: 10, completionTokens: 1, latencyMs: 1 };
  },
  async sentinel() { /* tests never reach a provider */ },
};

const tmpDirs: string[] = [];
const servers: StubChat[] = [];
const saved: Record<string, string | undefined> = {};

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-evidence-coverage-'));
  tmpDirs.push(dir);
  return dir;
}

function writeDataset(rows: Row[]): string {
  const file = path.join(tmpDir(), 'dataset.json');
  fs.writeFileSync(file, JSON.stringify(rows));
  return file;
}

function options(dataset: string): ProductRunnerOptions {
  return {
    dataset, output: path.join(path.dirname(dataset), 'out'), topK: 20, limit: 0, offset: 0,
    shardIndex: 0, shardCount: 1, maxContextTokens: 6000,
    embeddingProvider: 'eval-hash', arm: 'promotion', maxLiveCalls: 50, cache: false,
    answerModel: 'stub', judgeModel: 'stub', baseUrl: 'unused://stub',
    apiKeyEnv: 'UNUSED_KEY', temperature: 0, retries: 1,
  };
}

function run(dataset: string, hooks: ProductHooks) {
  return runProductBenchmark(options(dataset), hooks);
}

beforeEach(() => {
  for (const name of EVIDENCE_PROVIDER_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const name of EVIDENCE_PROVIDER_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('caseEvidence: one case, from the public surface\'s own report', () => {
  it('keeps the state, reason, item count, cache flag, model and error', () => {
    expect(caseEvidence({
      status: 'ok', state: 'ok', reason: 'mode-always', fromCache: true, model: 'm',
      items: [{ item: 'a' }, { item: 'b' }], sessions: [{ stem: 's', chars: 3 }], note: 'n',
    })).toEqual({ state: 'ok', reason: 'mode-always', items: 2, fromCache: true, model: 'm' });
    expect(caseEvidence({
      status: 'skipped', state: 'failed', reason: 'extractor-error', model: 'm', error: 'extractor provider returned 429', note: 'n',
    })).toEqual({ state: 'failed', reason: 'extractor-error', model: 'm', error: 'extractor provider returned 429' });
    expect(caseEvidence({ status: 'skipped', state: 'not-applied', reason: 'no-sessions', note: 'n' }))
      .toEqual({ state: 'not-applied', reason: 'no-sessions' });
  });

  it('a surface that said nothing is "unreported", never assumed fine', () => {
    for (const report of [undefined, null, 'ok', 7, [], {}, { state: 5 }, { status: 'ok' }]) {
      expect(caseEvidence(report), JSON.stringify(report)).toEqual({ state: 'unreported' });
    }
  });
});

describe('evidenceCoverage: the run, counted', () => {
  it('counts every state, the attached tables, the replays, the models, and lists each failure by id', () => {
    const coverage = evidenceCoverage([
      { id: 'q1', evidence: { state: 'ok', reason: 'mode-always', items: 2, fromCache: false, model: 'gemma4:31b' } },
      { id: 'q2', evidence: { state: 'ok', reason: 'mode-always', items: 0, fromCache: true, model: 'gemma4:31b' } },
      { id: 'q3', evidence: { state: 'ok', reason: 'mode-always', items: 4, fromCache: true, model: 'minimax-m3' } },
      { id: 'q4', evidence: { state: 'failed', reason: 'extractor-error', model: 'gemma4:31b', error: 'extractor provider returned 429' } },
      { id: 'q5', evidence: { state: 'failed', reason: 'extractor-parse-error', model: 'gemma4:31b' } },
      { id: 'q6', evidence: { state: 'unavailable', reason: 'extractor-unavailable' } },
      { id: 'q7', evidence: { state: 'not-applied', reason: 'intent' } },
      { id: 'q8', evidence: { state: 'off', reason: 'mode-off' } },
      { id: 'q9', evidence: { state: 'unreported' } },
      { id: 'q10' },
    ]);
    expect(coverage).toEqual({
      states: { ok: 3, failed: 2, unavailable: 1, 'not-applied': 1, off: 1, unreported: 2 },
      attached: 2,
      replayed: 2,
      failed: [
        { id: 'q4', reason: 'extractor-error', error: 'extractor provider returned 429' },
        { id: 'q5', reason: 'extractor-parse-error' },
      ],
      models: ['gemma4:31b', 'minimax-m3'],
    });
  });

  it('a run with no cases still has every state key', () => {
    expect(evidenceCoverage([])).toEqual({
      states: { ok: 0, failed: 0, unavailable: 0, 'not-applied': 0, off: 0, unreported: 0 },
      attached: 0, replayed: 0, failed: [], models: [],
    });
  });
});

describe('the run manifest records the evidence layer per case (issue #222 part 2)', () => {
  it('a failed extraction mid-run is counted and named by id, next to the cases that kept their table', async () => {
    const dataset = writeDataset([
      row('q_ok', 'How many days did we camp in May?'),
      row('q_empty', 'How many days did we camp in June?'),
      row('q_fail', 'How many days did we camp in July?'),
      row('q_silent', 'How many days did we camp in August?'),
    ]);
    const reports: Record<string, unknown> = {
      May: { status: 'ok', state: 'ok', reason: 'mode-always', fromCache: false, model: 'stub-extractor', items: [{ item: 'camping trip' }] },
      June: { status: 'ok', state: 'ok', reason: 'mode-always', fromCache: false, model: 'stub-extractor', items: [] },
      July: { status: 'skipped', state: 'failed', reason: 'extractor-error', model: 'stub-extractor', error: 'extractor provider returned 429' },
    };
    const hooks: ProductHooks = {
      publicSearch: async (args) => {
        const month = Object.keys(reports).find(name => args.query.includes(name));
        return {
          hits: [{ notePath: path.join(args.vaultDir, 'Sessions', 'trip.md'), text: 'We went camping for 3 days.', score: 1 }],
          transport: 'test', command: 'test', durationMs: 1,
          ...(month ? { evidence: reports[month] } : {}),
        };
      },
      models: stubModels,
    };
    const { manifest, cases } = await run(dataset, hooks);

    expect(manifest.evidence).toEqual({
      states: { ok: 2, failed: 1, unavailable: 0, 'not-applied': 0, off: 0, unreported: 1 },
      attached: 1,
      replayed: 0,
      failed: [{ id: 'q_fail', reason: 'extractor-error', error: 'extractor provider returned 429' }],
      models: ['stub-extractor'],
    });
    const byId = new Map(cases.map((c: ProductQaCase) => [c.id, c]));
    expect(byId.get('q_ok')?.evidence).toEqual({ state: 'ok', reason: 'mode-always', items: 1, fromCache: false, model: 'stub-extractor' });
    expect(byId.get('q_fail')?.evidence?.state).toBe('failed');
    expect(byId.get('q_silent')?.evidence).toEqual({ state: 'unreported' });
    // The checkpoint the scorer reads carries the same per-case record.
    const checkpoint = fs.readFileSync(path.join(path.dirname(dataset), 'out', 'qa-cases.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as ProductQaCase);
    expect(checkpoint.find(c => c.id === 'q_fail')?.evidence?.reason).toBe('extractor-error');
  });

  it('a bounded arm hands its bounds to the product process and records them; an unbounded arm records none', async () => {
    expect(productFeatureFlagOverrides({ RENOR_EVIDENCE_MAX_TOKENS: '4096', RENOR_EVIDENCE_REASONING_EFFORT: 'low' }))
      .toEqual(['RENOR_EVIDENCE_MAX_TOKENS=4096', 'RENOR_EVIDENCE_REASONING_EFFORT=low']);
    expect(productFeatureFlagOverrides({})).toEqual([]);

    process.env.RENOR_EVIDENCE_MAX_TOKENS = '4096';
    process.env.RENOR_EVIDENCE_REASONING_EFFORT = 'low';
    const childEnvs: Array<Record<string, string>> = [];
    const hooks: ProductHooks = {
      publicSearch: async (args) => {
        childEnvs.push({ ...args.env });
        return {
          hits: [{ notePath: path.join(args.vaultDir, 'Sessions', 'trip.md'), text: 'We went camping for 3 days.', score: 1 }],
          transport: 'test', command: 'test', durationMs: 1,
        };
      },
      models: stubModels,
    };
    const { manifest } = await run(writeDataset([row('q_bounded', 'How many days did we camp?')]), hooks);
    expect(childEnvs[0].RENOR_EVIDENCE_MAX_TOKENS).toBe('4096');
    expect(childEnvs[0].RENOR_EVIDENCE_REASONING_EFFORT).toBe('low');
    const overrides = (manifest.productMode as { overrides: string[] }).overrides;
    expect(overrides).toContain('RENOR_EVIDENCE_MAX_TOKENS=4096');
    expect(overrides).toContain('RENOR_EVIDENCE_REASONING_EFFORT=low');
  });

  it('the run ledger tells a bounded arm from an unbounded one, and one bound from another', () => {
    // Settings, not credentials (src/eval/runLedger.ts PRESENCE_ONLY_ENV keeps their values): a bounded rerun is a
    // new measurement, never refused as a repeat of the unbounded run, and two bounds never share a fingerprint.
    const fingerprint = (childEnv: Record<string, string>) => runFingerprint(productRunConfig({
      opts: options('/runs/dataset.json'), childEnv, datasetSha256: 'd'.repeat(64), questionIds: ['q1'], codeSha256: 'c'.repeat(64),
    }));
    const unbounded = { EMBEDDING_PROVIDER: 'eval-hash', LLM_EXTRACTION: 'false', RENOR_EVIDENCE_MODEL: 'stub-extractor' };
    const fingerprints = [
      fingerprint(unbounded),
      fingerprint({ ...unbounded, RENOR_EVIDENCE_MAX_TOKENS: '4096' }),
      fingerprint({ ...unbounded, RENOR_EVIDENCE_MAX_TOKENS: '8192' }),
      fingerprint({ ...unbounded, RENOR_EVIDENCE_REASONING_EFFORT: 'low' }),
      fingerprint({ ...unbounded, RENOR_EVIDENCE_REASONING_EFFORT: 'high' }),
    ];
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('end to end through the real CLI: an extractor that fails is in the manifest, by case id', async () => {
    const chat = await startStubChat(() => ({ status: 400, body: { error: 'model not served' } }));
    servers.push(chat);
    // The runner hands its own environment to the product CLI (plus the per-case vault and DB).
    process.env.RENOR_EVIDENCE_BASE_URL = chat.baseUrl;
    process.env.RENOR_EVIDENCE_API_KEY = 'k';
    process.env.RENOR_EVIDENCE_MODEL = 'stub-extractor';
    const dataset = writeDataset([row('q_cli', 'How many days did we camp?')]);
    const { manifest, cases } = await run(dataset, { publicSearch: cliPublicSearch, models: stubModels });

    expect(chat.requests.length).toBeGreaterThan(0);
    expect(cases[0].evidence).toMatchObject({ state: 'failed', reason: 'extractor-error', model: 'stub-extractor' });
    expect(manifest.evidence).toMatchObject({
      states: { ok: 0, failed: 1, unreported: 0 },
      attached: 0,
      failed: [{ id: 'q_cli', reason: 'extractor-error' }],
    });
  }, SPAWN_BUDGET_MS);

  it('the score report carries the manifest\'s evidence block next to the score', () => {
    const root = tmpDir();
    const evidence = {
      states: { ok: 0, failed: 1, unavailable: 0, 'not-applied': 0, off: 0, unreported: 0 },
      attached: 0, replayed: 0, failed: [{ id: 'q1', reason: 'extractor-error' }], models: ['stub-extractor'],
    };
    for (const [name, manifest] of [['with', { evidence }], ['without', {}]] as const) {
      const qa = path.join(root, name, 'qa');
      const retrieval = path.join(root, name, 'retrieval');
      fs.mkdirSync(qa, { recursive: true });
      fs.mkdirSync(retrieval, { recursive: true });
      fs.writeFileSync(path.join(qa, 'manifest.json'), JSON.stringify({ executionKind: 'research', watermark: 'RESEARCH-ONLY', ...manifest }));
      fs.writeFileSync(path.join(retrieval, 'manifest.json'), '{}');
      fs.writeFileSync(path.join(qa, 'qa-cases.jsonl'), JSON.stringify({
        id: 'q1', category: 'multi-session', shouldAbstain: false, hitsUsed: 1, contextTokens: 10,
        answer: { text: '3 days', modelEcho: 'a', finishReason: 'stop', latencyMs: 1 },
        judge: { raw: '1', verdict: 1, parseOk: true, modelEcho: 'j', latencyMs: 1 },
      }) + '\n');
      fs.writeFileSync(path.join(retrieval, 'cases.jsonl'), JSON.stringify({ id: 'q1', category: 'multi-session', query: 'q', relevant: [], expectedAnswer: '3 days', shouldAbstain: false, split: 'test' }) + '\n');
      fs.writeFileSync(path.join(retrieval, 'results.jsonl'), JSON.stringify({ id: 'q1', hits: [] }) + '\n');
      const output = path.join(root, name, 'report.json');
      const scored = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval/score-longmemeval-qa.ts', '--qa', qa, '--run', retrieval, '--output', output, '--label', 'research'], { encoding: 'utf8', cwd: REPO_ROOT });
      expect(scored.status, scored.stderr).toBe(0);
      const report = JSON.parse(fs.readFileSync(output, 'utf8')) as { evidence?: unknown; correct: number };
      expect(report.correct).toBe(1);
      expect(report.evidence).toEqual(name === 'with' ? evidence : null);
    }
  }, SPAWN_BUDGET_MS);
});
