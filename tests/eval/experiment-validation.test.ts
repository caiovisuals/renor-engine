import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';
import { sha256, assertRegularTree } from '../../src/eval/artifacts';
import { parseTimestamp, validateLongMemRows, type LongMemInstance } from '../../src/eval/longmemeval';

const row: LongMemInstance = { question_id: 'q', question: 'Which drink?', question_type: 'single-session-user',
  question_date: '2023/05/20 (Sat) 02:10', answer: 'tea', haystack_session_ids: ['s'],
  haystack_dates: ['2023/05/19 (Fri) 02:10'], haystack_sessions: [[{ role: 'user', content: 'I like tea.' }]], answer_session_ids: ['s'] };
const cs: EvalCase[] = [
  { id: 'a', query: 'q', category: 'stable_fact', relevant: [{ match: 'gold' }], split: 'dev' },
  { id: 'b', query: 'q2', category: 'temporal', relevant: [{ match: 'gold' }], split: 'dev' },
  { id: 'z', query: 'unknown', category: 'abstention', relevant: [], shouldAbstain: true, split: 'dev' },
];
const jl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
function tmp(f: (p: string) => void) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-experiment-test-')); try { f(p); } finally { fs.rmSync(p, { recursive: true, force: true }); } }
function cli(script: string, args: string[]) { return spawnSync(process.execPath, ['--import', 'tsx', `scripts/eval/${script}`, ...args], { encoding: 'utf8' }); }
// Each cli() call starts `tsx`: 0.3-0.8s of CPU per case (measured, 3 runs; the NEUTRAL/IMPROVED case spawns twice).
// The budget is 20x the slowest, rounded up to 5s, so a case passes while its process tree gets about 5% of one core.
const SPAWN_BUDGET_MS = 20_000;

/** Manifest/artifact shape produced by run-renorbench schemaVersion 2. */
function writeRun(dir: string, hits: string[][], latencyMs = 10) {
  fs.mkdirSync(dir);
  const results: EvalResult[] = cs.map((c, i) => ({
    id: c.id, hits: hits[i].map(text => ({ text })), latencyMs, contextTokens: 10,
  }));
  const manifest = {
    schemaVersion: 2, benchmark: 'renorbench-v1', gitSha: 'test-only', gitDirty: false,
    gitStatusSha256: null, evaluatorSha256: sha256('frozen-evaluator'), topK: 10, caseCount: cs.length,
    qualityEligible: true, provider: { kind: 'local', model: 'test-only', dimensions: 16 },
    chunking: { maxTokens: 400, overlapTokens: 50 }, conditions: { fixed: 'test' },
    casesSha256: sha256(jl(cs)), caseSnapshotSha256: sha256(jl(cs)),
    resultsSha256: sha256(jl(results)), fixtureSha256: sha256('test-fixture'),
  };
  for (const [name, value] of Object.entries({
    'manifest.json': JSON.stringify(manifest),
    'summary.json': JSON.stringify(scoreRetrieval(cs, results)),
    'cases.jsonl': jl(cs), 'results.jsonl': jl(results),
  })) fs.writeFileSync(path.join(dir, name), value as string);
}

it('parses official dates deterministically in UTC and rejects ambiguous/invalid dates', () => {
  expect(parseTimestamp(row.question_date).toISOString()).toBe('2023-05-20T02:10:00.000Z');
  expect(() => parseTimestamp('yesterday')).toThrow();
  expect(() => parseTimestamp('2023-05-20T02:10:00')).toThrow();
});

it('rejects duplicate question/answer IDs and absent answer evidence, allows repeated noise sessions', () => {
  expect(() => validateLongMemRows([row, row])).toThrow(/duplicate/i);
  expect(() => validateLongMemRows([{ ...row, answer_session_ids: ['s', 's'] }])).toThrow(/duplicate/i);
  expect(() => validateLongMemRows([{ ...row, answer_session_ids: ['missing'] }])).toThrow(/evidence/i);
  expect(() => validateLongMemRows([{ ...row, answer_session_ids: [] }])).toThrow(/evidence/i);
  const dupNoise = { ...row, haystack_session_ids: ['s', 'n', 'n'],
    haystack_dates: [row.haystack_dates[0], row.haystack_dates[0], row.haystack_dates[0]],
    haystack_sessions: [row.haystack_sessions[0], row.haystack_sessions[0], row.haystack_sessions[0]] };
  expect(() => validateLongMemRows([dupNoise])).not.toThrow();
  expect(() => validateLongMemRows([row])).not.toThrow();
});

it('rejects symlink fixtures instead of reading/changing external data', () => tmp(p => {
  fs.writeFileSync(path.join(p, 'target'), 'x');
  fs.symlinkSync(path.join(p, 'target'), path.join(p, 'link'));
  expect(() => assertRegularTree(p)).toThrow(/non-regular/i);
}));

it('rejects category regression hidden behind equal aggregate quality', () => tmp(p => {
  writeRun(path.join(p, 'b'), [[], ['gold'], []]);
  writeRun(path.join(p, 'c'), [['gold'], [], []]);
  const r = cli('compare-runs.ts', [path.join(p, 'b'), path.join(p, 'c')]);
  expect(r.status, r.stderr).toBe(3);
  expect(JSON.parse(r.stdout).verdict).toBe('REGRESSED');
  expect(JSON.parse(r.stdout).categoryRegressions.length).toBeGreaterThan(0);
}), SPAWN_BUDGET_MS);

it('rejects abstention regression even when answerable quality improves', () => tmp(p => {
  writeRun(path.join(p, 'b'), [[], ['gold'], []]);
  writeRun(path.join(p, 'c'), [['gold'], ['gold'], ['irrelevant']]);
  const r = cli('compare-runs.ts', [path.join(p, 'b'), path.join(p, 'c')]);
  expect(r.status, r.stderr).toBe(3);
}), SPAWN_BUDGET_MS);

it('treats sub-materiality efficiency gains as NEUTRAL, material ones as IMPROVED', () => tmp(p => {
  writeRun(path.join(p, 'b'), [['gold'], ['gold'], []], 100);
  writeRun(path.join(p, 'c'), [['gold'], ['gold'], []], 96.5); // 3.5% < 5% materiality
  const small = cli('compare-runs.ts', [path.join(p, 'b'), path.join(p, 'c')]);
  expect(small.status, small.stderr).toBe(0);
  expect(JSON.parse(small.stdout).verdict).toBe('NEUTRAL');
  writeRun(path.join(p, 'd'), [['gold'], ['gold'], []], 50); // 50% >= 5%
  const material = cli('compare-runs.ts', [path.join(p, 'b'), path.join(p, 'd')]);
  expect(JSON.parse(material.stdout).verdict).toBe('IMPROVED');
}), SPAWN_BUDGET_MS);

it('rejects tampered summaries rather than trusting supplied scores', () => tmp(p => {
  writeRun(path.join(p, 'b'), [[], ['gold'], []]);
  writeRun(path.join(p, 'c'), [['gold'], ['gold'], []]);
  fs.writeFileSync(path.join(p, 'c', 'summary.json'), JSON.stringify({ overall: { hitAt1: 1 } }));
  expect(cli('compare-runs.ts', [path.join(p, 'b'), path.join(p, 'c')]).status).not.toBe(0);
}), SPAWN_BUDGET_MS);

it('rejects unknown result ids and missing results in rescored runs', () => tmp(p => {
  writeRun(path.join(p, 'b'), [['gold'], ['gold'], []]);
  const results = fs.readFileSync(path.join(p, 'b', 'results.jsonl'), 'utf8');
  fs.writeFileSync(path.join(p, 'b', 'results.jsonl'), results + JSON.stringify({ id: 'ghost', hits: [] }) + '\n');
  expect(cli('compare-runs.ts', [path.join(p, 'b'), path.join(p, 'b')]).status).not.toBe(0);
}), SPAWN_BUDGET_MS);