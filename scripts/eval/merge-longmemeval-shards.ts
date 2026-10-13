import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';
import { claimDirectory, sha256 } from '../../src/eval/artifacts';

const program = new Command().argument('<shards...>').requiredOption('--output <path>')
  .option('--include-abstention', 'must match each shard scoring policy')
  .option('--allow-partial', 'explicit incomplete dataset diagnostic, never a full baseline')
  .parse(process.argv);
const opts = program.opts();
const dirs = program.args.map(dir => path.resolve(dir));
const manifests = dirs.map(dir => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
const reference = manifests[0];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort();
const cases: EvalCase[] = [], results: EvalResult[] = [], perCase: { id: string }[] = [];
const shardIndexes = new Set<number>();
const invariantKeys = ['benchmark', 'gitSha', 'gitDirty', 'gitStatusSha256', 'datasetSha256', 'datasetIds', 'topK', 'chunking', 'conditions', 'evaluatorSha256', 'includeAbstention', 'metricProtocol'];
// Provider IDENTITY must match across shards, but live usage counters
// (requests/inputTokens/cache hits+misses) legitimately differ per shard —
// they are measurements of each shard's own work, not configuration.
const providerIdentity = (p: Record<string, unknown>) => JSON.stringify({ ...p, usage: undefined, cache: p.cache ? { namespace: (p.cache as Record<string, unknown>).namespace } : undefined });
for (let i = 0; i < manifests.length; i++) {
  const m = manifests[i];
  if (m.schemaVersion !== 2 || m.benchmark !== 'longmemeval-s-retrieval' || m.gitDirty !== false
      || !m.shard || !Array.isArray(m.datasetIds) || m.datasetIds.length !== m.fullDatasetCases
      || new Set(m.datasetIds).size !== m.datasetIds.length || !m.datasetIds.length) throw new Error('Invalid/dirty shard manifest');
  for (const key of invariantKeys) {
    if (m[key] === undefined || !equal(m[key], reference[key])) throw new Error(`Shard differs/missing invariant: ${key}`);
  }
  if (!m.provider || !reference.provider || providerIdentity(m.provider) !== providerIdentity(reference.provider)) throw new Error('Shard differs/missing invariant: provider');
  if (Boolean(m.productEvidence) !== Boolean(reference.productEvidence)) throw new Error('Shard differs/missing invariant: productEvidence');
  if (m.includeAbstention !== Boolean(opts.includeAbstention)) throw new Error('Abstention policy mismatch');
  for (const key of ['index', 'count', 'offset', 'limit']) {
    if (!Number.isInteger(m.shard[key]) || m.shard[key] < (key === 'count' ? 1 : 0)) throw new Error('Invalid shard selection');
  }
  if (m.shard.index >= m.shard.count || m.shard.count !== reference.shard.count || shardIndexes.has(m.shard.index)) throw new Error('Duplicate/invalid shard index/count');
  shardIndexes.add(m.shard.index);
  const expected = m.datasetIds.filter((_: string, index: number) => index % m.shard.count === m.shard.index)
    .slice(m.shard.offset, m.shard.limit === 0 ? undefined : m.shard.offset + m.shard.limit);
  if (!equal(expected, m.selectionIds) || expected.length !== m.selectedCases) throw new Error('Incorrect shard selection IDs/count');
  function rows<T>(file: string, hashKey: string): T[] {
    const bytes = fs.readFileSync(path.join(dirs[i], file));
    if (sha256(bytes) !== m[hashKey]) throw new Error(`Artifact hash mismatch: ${file}`);
    return bytes.toString().trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }
  const cs = rows<EvalCase>('cases.jsonl', 'caseSnapshotSha256');
  const rs = rows<EvalResult>('results.jsonl', 'resultsSha256');
  const ps = rows<{ id: string }>('per-case.jsonl', 'perCaseSha256');
  const sorted = [...expected].sort();
  if (!equal(ids(cs), sorted) || !equal(ids(rs), sorted) || !equal(ids(ps), sorted)) throw new Error('Missing/duplicate/unknown question in shard artifacts');
  scoreRetrieval(cs, rs); // validates ALL rows, including excluded abstentions
  cases.push(...cs); results.push(...rs); perCase.push(...ps);
}
const complete = shardIndexes.size === reference.shard.count
  && equal(ids(cases), [...reference.datasetIds].sort());
if (!complete && !opts.allowPartial) throw new Error('Incomplete dataset/shards; pass --allow-partial for diagnostic only');
// Global bijection: no duplicate IDs, no discarded extra results.
scoreRetrieval(cases, results);
const resultMap = new Map(results.map(r => [r.id, r]));
cases.sort((a, b) => a.id.localeCompare(b.id));
const ordered = cases.map(c => resultMap.get(c.id)!);
const scored = cases.filter(c => opts.includeAbstention || !c.shouldAbstain);
if (!scored.length) throw new Error('No answerable cases');
const summary = scoreRetrieval(scored, scored.map(c => resultMap.get(c.id)!));
const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const merged = { ...reference, provider: {
    ...reference.provider,
    usage: {
      requests: manifests.reduce((n, m) => n + (m.provider?.usage?.requests ?? 0), 0),
      inputTokens: manifests.reduce((n, m) => n + (m.provider?.usage?.inputTokens ?? 0), 0),
      maxInputTokens: manifests.reduce((n, m) => Math.max(n, m.provider?.usage?.maxInputTokens ?? 0), 0),
    },
    cache: {
      ...reference.provider.cache,
      hits: manifests.reduce((n, m) => n + (m.provider?.cache?.hits ?? 0), 0),
      misses: manifests.reduce((n, m) => n + (m.provider?.cache?.misses ?? 0), 0),
    },
  }, shard: null, completeDataset: complete,
  mergedShardIndexes: [...shardIndexes].sort((a, b) => a - b),
  selectionIds: cases.map(c => c.id), selectedCases: cases.length, scoredCases: scored.length,
  abstentionCasesExcludedFromOfficialStyleRetrieval: cases.length - scored.length,
  mergedAt: new Date().toISOString(),
  resultsSha256: sha256(jsonl(ordered)), caseSnapshotSha256: sha256(jsonl(cases)), perCaseSha256: sha256(jsonl(perCase)),
  timing: { totalIndexMs: manifests.reduce((n, m) => n + m.timing.totalIndexMs, 0),
    totalRetrievalMs: manifests.reduce((n, m) => n + m.timing.totalRetrievalMs, 0) },
};
const output = path.resolve(opts.output);
claimDirectory(output);
for (const [file, data] of Object.entries({ 'manifest.json': JSON.stringify(merged, null, 2), 'summary.json': JSON.stringify(summary, null, 2),
  'cases.jsonl': jsonl(cases), 'results.jsonl': jsonl(ordered), 'per-case.jsonl': jsonl(perCase) })) fs.writeFileSync(path.join(output, file), data);
console.log(JSON.stringify({ output, manifest: merged, summary }, null, 2));
