/**
 * How long an agent's tool call waits when the embedding service refuses or stalls, against the product's own
 * Vertex stack (`createEmbeddingProvider`: the Vertex provider with its retry loop, then the query cache) pointed at a
 * local stub. No Google call, no credential: the stub (tests/helpers/vertexStub.ts) answers 429, 503 or nothing on demand.
 *
 *   npx tsx scripts/bench/embed-throttle-latency.ts --mode throttle --window-s 40
 *   npx tsx scripts/bench/embed-throttle-latency.ts --mode hang --window-s 40
 *
 * The workspace saves two notes while the service is healthy (the control: what each tool costs normally), then the
 * stub goes bad for `--window-s` seconds from the first call, and the five tools an agent uses are called one second
 * apart: remember (a note), remember (a fact), save_memory, get_context, search_memory. They are fired together and
 * each is timed until it answers. Afterwards the stub recovers, and the script reports how long until every saved
 * chunk has its vector, which is when the memory is findable by meaning too. On 2026-10-06 the real outage did this to
 * the captain's workspace for 17 minutes: `remember` took 645-777 s, `get_context` 497 s.
 *
 * Retry waits are the product's (10 s, 20 s ... up to 120 s) unless `--fast-retry` shortens them.
 *
 *   npx tsx scripts/bench/embed-throttle-latency.ts --healthy 40
 *
 * is the other half: the same stack with the service healthy, N saves of a note and N reads of each kind, median and
 * p95 per tool. Run it from each of two checkouts, alternating, to show a healthy service costs the same as before.
 */
import { createEmbeddingProvider } from '../../src/mvp/engine';
import { chunksWithoutVectors } from '../../src/embeddings/rebuild';
import { startVertexStub, type VertexStubMode } from '../../tests/helpers/vertexStub';
import { startWorkspace, vertexConfigFor, restoreWorkspaceEnv } from '../../tests/helpers/mvpWorkspace';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const mode = arg('mode', 'throttle') as VertexStubMode;
const windowMs = Number(arg('window-s', '40')) * 1000;
const fastRetry = process.argv.includes('--fast-retry');
const healthyRuns = Number(arg('healthy', '0'));

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const stub = await startVertexStub();
  const ws = await startWorkspace(config => createEmbeddingProvider(
    vertexConfigFor(config, stub.keyFile),
    { baseUrl: stub.baseUrl, ...(fastRetry ? { retry: { waitMs: (attempt: number) => 300 * 2 ** attempt } } : {}) },
  ));
  const db = ws.service.db;
  const out = process.stdout.write.bind(process.stdout);
  const log = console.log;
  const quiet = () => {};
  console.error = quiet; // the engine logs each failure it handles; the table below is the report
  console.log = quiet;
  try {
    if (healthyRuns > 0) {
      const times: Record<string, number[]> = { remember: [], get_context: [], search_memory: [] };
      for (let i = 0; i < healthyRuns; i++) {
        times.remember.push((await ws.timed('remember', { statement: `Note ${i}: the batch job ${i} runs at ${i % 24}:00 UTC on Sundays.` })).ms);
        times.get_context.push((await ws.timed('get_context', { query: `When does the batch job ${i} run?` })).ms);
        times.search_memory.push((await ws.timed('search_memory', { query: `batch job ${i} Sundays` })).ms);
      }
      const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
      log(JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, { median: q(v, 0.5), p95: q(v, 0.95) }]))));
      return;
    }
    await ws.call('remember', { statement: 'The Atlas staging cluster runs on ECS.' });
    await ws.call('remember', { statement: 'Kestrel uses Expo Router for navigation.', subject: 'Kestrel', predicate: 'navigation', object: 'Expo Router' });
    const control = [
      await ws.timed('remember', { statement: 'The quarterly access review is due on November 15.' }),
      await ws.timed('remember', { statement: 'The carrier rates API key rotates every 90 days.', subject: 'carrier rates API key', predicate: 'rotation', object: 'every 90 days' }),
      await ws.timed('save_memory', { subject: 'Atlas staging', predicate: 'node_count', object: '3' }),
      await ws.timed('get_context', { query: 'When is the quarterly access review due?' }),
      await ws.timed('search_memory', { query: 'quarterly access review' }),
    ];

    stub.mode = mode;
    const outageStart = Date.now();
    setTimeout(() => { stub.mode = 'ok'; }, windowMs).unref();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['remember', { statement: 'The ledger export job runs at 02:00 UTC on Sundays.' }],
      ['remember', { statement: 'The billing webhook retries three times.', subject: 'billing webhook', predicate: 'retries', object: '3' }],
      ['save_memory', { subject: 'Atlas staging', predicate: 'region', object: 'us-east-1' }],
      ['get_context', { query: 'When does the ledger export job run?' }],
      ['search_memory', { query: 'ledger export job' }],
    ];
    const results = await Promise.all(calls.map(async ([name, args], i) => {
      await sleep(i * 1000);
      const startedAt = Date.now() - outageStart;
      const r = await ws.timed(name, args);
      const b = r.body;
      const notes = [
        b.warning ? `warning=${b.warning}` : null,
        b.indexed === false ? 'indexed=false' : null,
        b.notice ? 'notice' : null,
        b.retrieval ? `retrieval=${b.retrieval}` : null,
        r.isError ? 'isError' : null,
      ].filter(Boolean).join(' ');
      return { name, startedAtS: Math.round(startedAt / 100) / 10, ms: r.ms, notes };
    }));

    const findableAfterMs = await (async () => {
      const t0 = Date.now();
      while (chunksWithoutVectors(db) > 0 && Date.now() - t0 < 15 * 60_000) await sleep(500);
      return chunksWithoutVectors(db) === 0 ? Date.now() - outageStart : null;
    })();
    log(JSON.stringify({
      mode, windowS: windowMs / 1000, fastRetry,
      control: control.map((c, i) => ({ call: calls[i][0], ms: c.ms })),
      outage: results,
      allChunksHaveVectorsAfterS: findableAfterMs === null ? null : Math.round(findableAfterMs / 100) / 10,
      stubRequests: stub.counts,
    }, null, 2));
  } finally {
    await ws.close();
    await stub.close();
    restoreWorkspaceEnv();
    console.log = log;
  }
}

const report = console.error;
main().then(() => process.exit(0), (err) => { report(err); process.exit(1); });
