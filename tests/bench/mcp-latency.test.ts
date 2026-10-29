import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { runBench, compare, stat, withBenchEnv, benchOptionsFromArgs, fixtureFor, LIVE_SHAPE, type BenchOptions, type BenchResult } from '../../scripts/bench/mcp-latency';
import { tmpPath } from '../helpers/tmpPath';

/**
 * The latency benchmark is the instrument every read-path speed claim rests on, so it is held to the
 * contract its A/B comparisons depend on: it drives the real MCP tools, two runs over one fixture
 * answer byte-for-byte alike, and a changed response is reported rather than averaged away.
 * A tiny workspace keeps this fast; `hash` embeddings mean no model and no network.
 */
const options = (over: Partial<BenchOptions> = {}): BenchOptions => ({
  sizes: [24], runs: 2, embeddings: 'hash', dims: 32, dir: tmpPath('bench-fixtures'), ...over,
});

describe('mcp latency bench', () => {
  it('measures get_context and search_memory through the MCP surface, byte-deterministically', async () => {
    const a = await runBench(options({ label: 'a' }));
    const b = await runBench(options({ label: 'b' })); // reuses the generated fixture
    const size = a.sizes['24'];

    expect(Object.keys(size.stats).sort()).toEqual(['get_context', 'search_memory']);
    // The event loop's own CPU is reported beside the process total (it is the work a call waits on).
    expect(Object.keys(size.threadStats ?? {}).sort()).toEqual(['get_context', 'search_memory']);
    expect(size.threadStats!.get_context.medianMs).toBeLessThanOrEqual(size.cpuStats.get_context.p95Ms);
    expect(size.stats.get_context.n).toBe(13 * 2);
    expect(size.stats.search_memory.n).toBe(8 * 2);
    expect(size.facts).toBeGreaterThanOrEqual(20);
    // Real answers, not error stubs: the plain profile call and a semantic query both return a body.
    expect(size.responseBytes['get_context:profile']).toBeGreaterThan(50);
    expect(size.responseBytes['search_memory:nl-topic']).toBeGreaterThan(50);

    expect(b.sizes['24'].digests).toEqual(size.digests);
    const verdict = compare([a], [b]);
    expect(verdict.identical).toBe(true);
    expect(verdict.lines.at(-1)).toMatch(/^RESULT SETS IDENTICAL: \d+ response digests compared across 2 runs/);
  }, 120_000);

  it('reports a response that differs between two trees, and runs that are not comparable', async () => {
    const a = await runBench(options({ label: 'before' }));
    const changed: BenchResult = JSON.parse(JSON.stringify(a));
    changed.meta.label = 'after';
    changed.sizes['24'].digests['get_context:nl-topic'] = 'f'.repeat(64);

    const verdict = compare([a], [changed]);
    expect(verdict.identical).toBe(false);
    expect(verdict.lines.some(l => l.startsWith('DIFF n=24 get_context:nl-topic (after'))).toBe(true);

    const other = JSON.parse(JSON.stringify(a)) as BenchResult;
    other.meta.dims = 768;
    expect(compare([a], [other]).lines.some(l => l.startsWith('WARNING:'))).toBe(true);
  }, 120_000);

  it('the wide query set adds the other read tools and the scope, budget and history paths, and every call answers deterministically', async () => {
    const a = await runBench(options({ label: 'wide-a', queries: 'wide', runs: 1 }));
    const b = await runBench(options({ label: 'wide-b', queries: 'wide', runs: 1 }));
    const size = a.sizes['24'];
    expect(Object.keys(size.stats).sort()).toEqual(['get_context', 'lookup_entity', 'retrieve_memory', 'search_memory', 'search_text']);
    expect(Object.keys(size.digests).length).toBeGreaterThan(90);
    // Every default call is still there, with the digest it has without the wide set: the wide set only adds.
    const narrow = await runBench(options({ label: 'narrow', runs: 1 }));
    for (const [key, digest] of Object.entries(narrow.sizes['24'].digests)) expect(size.digests[key], key).toBe(digest);
    expect(b.sizes['24'].digests).toEqual(size.digests);
    expect(compare([a], [b]).identical).toBe(true);
    // Reaches what the default set does not: scopes, token budgets, history, and a query that is not Latin text.
    const keys = Object.keys(size.digests);
    for (const part of ['scope-project:alpha', 'budget-128', 'history', 'odd-text']) expect(keys.some(k => k.includes(part)), part).toBe(true);
  }, 240_000);

  it('can be narrowed to some tools or calls, and says so when nothing is left', async () => {
    const some = await runBench(options({ runs: 1, tools: ['get_context'], calls: /:scoped$/ }));
    expect(Object.keys(some.sizes['24'].digests)).toEqual(['get_context:scoped']);
    await expect(runBench(options({ runs: 1, tools: ['lookup_entity'] }))).rejects.toThrow(/no calls to measure/);
  }, 120_000);

  it('builds a workspace of the shape asked for, and keeps it apart from the default one', async () => {
    const dir = tmpPath('bench-shaped');
    const plain = await runBench(options({ dir, runs: 1 }));
    const shaped = await runBench(options({ dir, runs: 1, padSections: 3, facts: 31, factSubjects: 12 }));
    expect(plain.sizes['24'].facts).toBe(20);
    expect(shaped.sizes['24'].facts).toBe(31);
    // A different shape is a different fixture, never the other one reused: the same questions answer differently.
    expect(shaped.sizes['24'].digests['get_context:nl-topic']).not.toBe(plain.sizes['24'].digests['get_context:nl-topic']);
  }, 240_000);

  it('writes a V8 profile of the measured passes when asked, and not otherwise', async () => {
    const file = tmpPath('bench-profile.cpuprofile');
    await runBench(options({ runs: 2, tools: ['get_context'], cpuProfile: file }));
    const profile = JSON.parse(fs.readFileSync(file, 'utf8')) as { nodes: unknown[]; samples: number[]; timeDeltas: number[] };
    expect(profile.nodes.length).toBeGreaterThan(10);
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(profile.timeDeltas).toHaveLength(profile.samples.length);
    const none = tmpPath('bench-no-profile.cpuprofile');
    await runBench(options({ runs: 1, tools: ['get_context'] }));
    expect(fs.existsSync(none)).toBe(false);
  }, 120_000);

  it('without an embedding provider measures get_context only (search_memory has nothing to answer)', async () => {
    const r = await runBench(options({ embeddings: 'none', runs: 1 }));
    expect(Object.keys(r.sizes['24'].stats)).toEqual(['get_context']);
  }, 120_000);

  it('leaves the process as it found it: real clock, console, telemetry setting', async () => {
    const now = Date.now, log = console.log, telemetry = process.env.RENOR_TELEMETRY_DISABLED;
    await runBench(options({ runs: 1 }));
    expect(Date.now).toBe(now);
    expect(console.log).toBe(log);
    expect(process.env.RENOR_TELEMETRY_DISABLED).toBe(telemetry);
  }, 120_000);

  it('never lets a model-call credential or ambient setting reach the engine, and puts everything back', async () => {
    // Fake values only. A shell that sourced a secrets file carries exactly these shapes; the default-on evidence
    // pass would use the Ollama pool for a real extraction call on every query.
    const planted: Record<string, string> = {
      OLLAMA_CLOUD_KEY_1: 'not-a-real-key', OLLAMA_API_KEY: 'not-a-real-key', RENOR_EVIDENCE_API_KEY: 'not-a-real-key',
      RENOR_POSTHOG_KEY: 'not-a-real-key', SOME_SERVICE_TOKEN: 'not-a-real-token', MVP_PORT: '4242', RENOR_EVIDENCE_MODE: 'always',
      RENOR_EVAL_VERTEX_PROJECT: 'not-a-project', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/key.json',
    };
    const before = Object.fromEntries(Object.keys(planted).map(k => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      const inside = await withBenchEnv(false, 'off', async () => ({ ...process.env }));
      for (const k of Object.keys(planted)) expect(inside[k], k).toBeUndefined();
      expect(inside.RENOR_TELEMETRY_DISABLED).toBe('true');
      expect(inside.RENOR_SEARCH_EVIDENCE).toBe('0');

      const vertex = await withBenchEnv(true, 'default', async () => ({ ...process.env }));
      expect(vertex.RENOR_EVAL_VERTEX_PROJECT).toBe('not-a-project'); // what the vertex tier needs...
      expect(vertex.GOOGLE_APPLICATION_CREDENTIALS).toBe('/nonexistent/key.json');
      expect(vertex.OLLAMA_CLOUD_KEY_1).toBeUndefined();             // ...and nothing that could reach a model
      expect(vertex.RENOR_EVIDENCE_API_KEY).toBeUndefined();
      expect(vertex.SOME_SERVICE_TOKEN).toBeUndefined();
      expect(vertex.RENOR_SEARCH_EVIDENCE).toBeUndefined();          // `default` leaves the shipped default alone

      for (const [k, v] of Object.entries(planted)) expect(process.env[k], k).toBe(v);
    } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('reads a command line into the options, with the live shape as a preset that single flags override', () => {
    const { options: all, out } = benchOptionsFromArgs([
      'scripts/bench/mcp-latency.ts', '--sizes', '85,100', '--runs', '3', '--embeddings', 'cache-only', '--embed-cache', '/c.db', '--dir', '/d', '--out', '/o.json',
      '--label', 'x', '--shape', 'live', '--facts', '12', '--queries', 'wide', '--tools', 'get_context,search_memory', '--calls', ':scoped$', '--evidence', 'off', '--per-call',
    ]);
    expect(out).toBe('/o.json');
    expect(all).toMatchObject({
      sizes: [85, 100], runs: 3, embeddings: 'cache-only', embedCache: '/c.db', dir: '/d', label: 'x', dims: 768, evidence: 'off', perCall: true, profile: false, queries: 'wide',
      padSections: LIVE_SHAPE.padSections, facts: 12, factSubjects: LIVE_SHAPE.factSubjects, tools: ['get_context', 'search_memory'],
    });
    expect(all.calls).toEqual(/:scoped$/);

    expect(benchOptionsFromArgs([]).options).toMatchObject({ sizes: [100, 1000, 10000], runs: 7, embeddings: 'hash', dims: 768, evidence: 'default', queries: 'default', perCall: false });
    expect(benchOptionsFromArgs([]).options.narrowLedgerCheck).toBe(false);
    expect(benchOptionsFromArgs(['--narrow-ledger-check']).options).toMatchObject({ narrowLedgerCheck: true });
    expect(benchOptionsFromArgs([]).options.learningLog).toBe(false);
    expect(benchOptionsFromArgs(['--learning-log']).options).toMatchObject({ learningLog: true });
    expect(benchOptionsFromArgs(['--mirror-cap-mib', '400']).options).toMatchObject({ mirrorCapMib: 400 });
    expect(() => benchOptionsFromArgs(['--mirror-cap-mib', '0'])).toThrow(/--mirror-cap-mib must be a whole number of MiB, 1 or more/);
    expect(() => benchOptionsFromArgs(['--mirror-cap-mib', '1.5'])).toThrow(/--mirror-cap-mib must be a whole number of MiB, 1 or more/);
    expect(benchOptionsFromArgs(['--shape', 'live']).options).toMatchObject({ sizes: [LIVE_SHAPE.notes], padSections: 10, facts: 671, factSubjects: 220 });
    expect(benchOptionsFromArgs(['--embeddings', 'dense']).options).toMatchObject({ embeddings: 'dense' });
    expect(() => benchOptionsFromArgs(['--embeddings', 'local'])).toThrow(/--embeddings must be hash, dense, vertex, cache-only or none/);
    expect(() => benchOptionsFromArgs(['--profile', '--cpu-profile', 'x.cpuprofile'])).toThrow(/run them separately/);
  });

  it('measures with the cache-only tier only what exists: it makes no fixture and no cache, and it names what is missing', async () => {
    const o = options({ dir: tmpPath('bench-cache-only'), embeddings: 'cache-only', dims: 768, runs: 1 });
    await expect(runBench(o)).rejects.toThrow(/measures a fixture built beforehand/);
    const { memoryDir, fixture } = fixtureFor(o, 24);
    expect(path.basename(memoryDir)).toBe('n24-cache-only768');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, '.bench-fixture.json'), JSON.stringify(fixture));
    await expect(runBench(o)).rejects.toThrow(/needs --embed-cache/);
    const missing = tmpPath('no-such-cache.db');
    await expect(runBench({ ...o, embedCache: missing })).rejects.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  }, 60_000);

  it('summarises with nearest-rank median and p95', () => {
    const s = stat([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]);
    expect(s).toEqual({ n: 10, medianMs: 5, p95Ms: 10, maxMs: 10 });
  });
});
