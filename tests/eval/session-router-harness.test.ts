import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cliPublicSearch,
  parseProductArgs,
  parseRouterSummaryLine,
  runProductBenchmark,
  summarizeRouterCoverage,
  writeQuestionVault,
  type ProductHooks,
} from '../../scripts/eval/run-longmemeval-product';
import { startStubServer } from '../router/stubRouterModel';
import { SESSIONS } from '../router/fixtureSessions';

/**
 * The product benchmark client and RENOR_SESSION_ROUTER: the router's per-case report and index-time summary stats are
 * recorded with every case, and the manifest says how often the router routed and why it stepped aside, so a router
 * arm that quietly fell back to the control is visible (the issue #222 lesson). A control run is unchanged.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function dataset(root: string): string {
  const file = path.join(root, 'ds.json');
  const row = (id: string) => ({
    question_id: id,
    question: 'What are the names of the cats I adopted?',
    question_date: '2023/05/30 (Tue) 12:00',
    answer: 'Miso and Tofu',
    answer_session_ids: ['sess-cats-1', 'sess-cats-3'],
    question_type: 'multi-session',
    haystack_session_ids: SESSIONS.map(s => s.id),
    haystack_sessions: SESSIONS.map(s => s.turns),
    haystack_dates: SESSIONS.map(s => s.date),
  });
  fs.writeFileSync(file, JSON.stringify([row('router-q1'), row('router-q2')]));
  return file;
}

const models: ProductHooks['models'] = {
  modelCall: async (_callType, requestBody) => ({
    rawContent: JSON.stringify(requestBody).includes('impartial judge') ? '1' : 'Miso and Tofu',
    modelEcho: 'stub', finishReason: 'stop', latencyMs: 1, promptTokens: 1, completionTokens: 1,
  }),
  sentinel: async () => undefined,
};

async function run(root: string, publicSearch: ProductHooks['publicSearch']) {
  const opts = parseProductArgs([
    '--dataset', dataset(root), '--output', path.join(root, 'out'), '--embedding-provider', 'eval-hash',
    '--transport-smoke', '--limit', '0', '--max-live-calls', '10', '--no-cache',
  ]);
  return runProductBenchmark({
    ...opts, topK: Number(opts.topK), maxContextTokens: Number(opts.maxContextTokens), limit: 0, offset: 0, shardIndex: 0,
    shardCount: 1, temperature: 0, retries: 1, maxLiveCalls: 10, arm: 'iteration',
  }, { publicSearch, models });
}

describe('product client: session-router reports', () => {
  it('reads the index phase\'s [router] summaries line, and nothing else', () => {
    expect(parseRouterSummaryLine('Indexing: /v\nDone. 4/4 indexed, 0 errors.\n[router] summaries {"notes":4,"calls":1}\n')).toEqual({ notes: 4, calls: 1 });
    expect(parseRouterSummaryLine('Indexing: /v\nDone. 4/4 indexed, 0 errors.\n')).toBeUndefined();
    expect(parseRouterSummaryLine('[router] summaries {broken')).toBeUndefined();
  });

  it('records each case\'s router report (routed paths relative to the vault) and summarises coverage in the manifest', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-harness-'));
    try {
      let call = 0;
      const { manifest, cases } = await run(root, async args => {
        call++;
        const hit = { notePath: path.join(args.vaultDir, 'Sessions', 'x.md'), text: 'Miso and Tofu', score: 1 };
        return call === 1
          ? {
              hits: [hit], transport: 'test', command: 'test', durationMs: 1,
              router: {
                status: 'ok', mode: 'replace', fromCache: false, latencyMs: 1200, usage: { promptTokens: 600, completionTokens: 40 },
                routed: [{ notePath: path.join(args.vaultDir, 'Sessions', 'sess-cats-3.md'), statements: 2, tokens: 80 }], deliveredTokens: 80,
              },
              routerSummaries: { notes: 4, cached: 0, summarized: 4, failed: 0, calls: 1, promptTokens: 9000, completionTokens: 400 },
            }
          : {
              hits: [hit], transport: 'test', command: 'test', durationMs: 1,
              router: { status: 'skipped', reason: 'summaries-incomplete', mode: 'replace', missingSummaries: 1 },
              routerSummaries: { notes: 4, cached: 3, summarized: 0, failed: 1, calls: 1, promptTokens: 2000, completionTokens: 0 },
            };
      });
      expect(cases.map(c => c.router?.status)).toEqual(['ok', 'skipped']);
      expect((cases[0].router!.routed as Array<{ notePath: string }>)[0].notePath).toBe('Sessions/sess-cats-3.md');
      const checkpoint = fs.readFileSync(path.join(root, 'out', 'qa-cases.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(checkpoint[1].routerSummaries).toMatchObject({ failed: 1 });
      expect(manifest.routerCoverage).toEqual({
        cases: 2,
        routed: 1,
        skipped: { 'summaries-incomplete': 1 },
        meanRoutedSessions: 1,
        meanDeliveredTokens: 80,
        route: { answers: 1, liveCalls: 1, promptTokens: 600, completionTokens: 40, liveLatencyMsP50: 1200, liveLatencyMsP95: 1200 },
        summaries: { indexRuns: 2, notes: 8, cached: 3, summarized: 4, failed: 1, liveCalls: 2, promptTokens: 11000, completionTokens: 400 },
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a control run exactly as it was: no router field on a case, no routerCoverage in the manifest', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-control-'));
    try {
      const { manifest, cases } = await run(root, async args => ({
        hits: [{ notePath: path.join(args.vaultDir, 'Sessions', 'x.md'), text: 'Miso and Tofu', score: 1 }],
        transport: 'test', command: 'test', durationMs: 1,
      }));
      expect(cases.every(c => !('router' in c) && !('routerSummaries' in c))).toBe(true);
      expect('routerCoverage' in manifest).toBe(false);
      expect(summarizeRouterCoverage(cases)).toBeNull();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('carries the router report and summary stats from the real spawned CLI (stub model server, eval-hash)', async () => {
    const stub = await startStubServer();
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-router-cli-'));
    try {
      const row = JSON.parse(fs.readFileSync(dataset(root), 'utf8'))[0];
      const rendered = await writeQuestionVault(root, row);
      const env: Record<string, string> = {
        VAULT_PATH: rendered.vaultDir,
        DB_PATH: path.join(root, 'product.db'),
        EMBEDDING_PROVIDER: 'eval-hash',
        LLM_EXTRACTION: 'false',
        RENOR_SEARCH_EVIDENCE: '0',
        RENOR_SESSION_ROUTER: 'replace',
        RENOR_EVIDENCE_BASE_URL: stub.baseUrl,
        RENOR_EVIDENCE_API_KEY: 'stub-key',
        RENOR_ROUTER_MODEL: 'stub-router',
        RENOR_ROUTER_RETRIES: '0',
      };
      for (const key of Object.keys(process.env)) {
        if (/^(OLLAMA_|RENOR_|OPENAI_|EMBEDDING_)/.test(key) && !(key in env)) env[key] = '';
      }
      const result = await cliPublicSearch({
        query: `Question date: ${row.question_date}\n${row.question}`,
        vaultDir: rendered.vaultDir, dbPath: env.DB_PATH, env, topK: 20, cwd: REPO_ROOT,
      });
      expect(result.router).toMatchObject({ status: 'ok', mode: 'replace', model: 'stub-router', nodes: 4 });
      expect(result.routerSummaries).toMatchObject({ notes: 4, summarized: 4, failed: 0, calls: 1 });
      expect(result.hits.length).toBe(2);
    } finally {
      await stub.close();
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 240_000);
});
