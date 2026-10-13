#!/usr/bin/env node
/**
 * C1 offline selection-parity report (screen SCR-C1-SELECTION-PARITY).
 *
 * Card: docs/agents/queue/INBOX/HYP-20260921-evidence-session-parity.md
 *
 * Deterministic, offline, zero model calls, zero embeddings, gold-blind.
 * Given a product-path run dir (results.jsonl with the PUBLIC-SURFACE hits the
 * client received) + the LongMemEval dataset, this script rebuilds each case's
 * rendered markdown vault (same rendering rules as run-longmemeval-product.ts)
 * and compares the shipped first-12-by-encounter-rank session selection (a
 * deterministic pure function of the recorded hits + vault, i.e. the run's
 * recorded selections) against the RENOR_EVIDENCE_BODY_RANK=1 body-relevance
 * selection on the >12-unique-candidate slice.
 *
 * Gold isolation: only PRODUCT_RUNTIME_FIELD_ALLOWLIST dataset fields
 * (question_id/question/question_date/haystack_*) are read; gold fields
 * (answer, answer_session_ids, question_type, shouldAbstain) are never
 * accessed. This is a research/scoring diagnostic, never a product score.
 *
 * Usage:
 *   npx tsx scripts/eval/c1-selection-parity.ts <run-dir> --dataset <longmemeval.json> [--limit N] [--verbose]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { loadEvidenceSessionsFromVault } from '../../src/evidence/secondPass';
import { validateLongMemRows, type LongMemInstance } from '../../src/eval/longmemeval';
import { sha256 } from '../../src/eval/artifacts';
import { safeSegment, renderSession } from './run-longmemeval-product';

const program = new Command()
  .name('c1-selection-parity')
  .description('Offline C1 second-pass selection parity: shipped encounter-rank vs RENOR_EVIDENCE_BODY_RANK body relevance (zero model calls)')
  .argument('<run-dir>', 'product-path run dir containing results.jsonl')
  .requiredOption('--dataset <path>', 'LongMemEval dataset JSON (gold fields never read)')
  .option('--limit <n>', 'limit to first N cases', parseInt)
  .option('--max-sessions <n>', 'evidence session cap', parseInt, 12)
  .option('--char-cap <n>', 'per-session hydration char cap', parseInt, 6000)
  .option('--verbose', 'print per-case diff details', false)
  .parse(process.argv);

const opts = program.opts<{
  dataset: string;
  limit?: number;
  maxSessions: number;
  charCap: number;
  verbose: boolean;
}>();

interface RecordedHit { text: string; notePath: string; score: number }
interface RecordedResult { id: string; hits: RecordedHit[]; latencyMs?: number; contextTokens?: number }

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) throw new Error(`missing artifact: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

/** Last-wins compaction (same rule as the runner's checkpoint). */
function compact<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map(row => [row.id, row])).values()];
}

// ─── Vault rendering (shared with the runner — no local copies; review P2-2) ───

/** Runtime-visible dataset projection; gold fields are structurally dropped. */
function runtimeRow(row: LongMemInstance) {
  return {
    question_id: row.question_id,
    question: row.question,
    question_date: row.question_date,
    haystack_session_ids: row.haystack_session_ids,
    haystack_dates: row.haystack_dates,
    haystack_sessions: row.haystack_sessions,
  };
}

interface RenderedCaseVault {
  vaultDir: string;
  /** basename -> session_date (from the rendered frontmatter rules) */
  dateByBase: Map<string, string>;
}

async function renderCaseVault(row: ReturnType<typeof runtimeRow>, root: string): Promise<RenderedCaseVault> {
  const vaultDir = path.join(root, 'vault');
  const sessionsDir = path.join(vaultDir, 'Sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const dateByBase = new Map<string, string>();
  const occurrences = new Map<string, number>();
  for (let index = 0; index < row.haystack_session_ids.length; index++) {
    const id = row.haystack_session_ids[index];
    const dateText = row.haystack_dates[index];
    const nth = (occurrences.get(id) ?? 0) + 1;
    occurrences.set(id, nth);
    const segment = nth === 1 ? safeSegment(id) : `${safeSegment(id)}-occ${nth}`;
    const relative = `Sessions/${segment}.md`;
    await fsp.writeFile(path.join(vaultDir, relative), renderSession(id, dateText, row.haystack_sessions[index]), 'utf8');
    dateByBase.set(`${segment}.md`, dateText);
  }
  return { vaultDir, dateByBase };
}

async function main(): Promise<void> {
  const runDir = path.resolve(program.args[0]);
  const resultsPath = path.join(runDir, 'results.jsonl');
  const results = compact(readJsonl<RecordedResult>(resultsPath));
  const datasetRows = JSON.parse(fs.readFileSync(path.resolve(opts.dataset), 'utf8')) as LongMemInstance[];
  validateLongMemRows(datasetRows);
  const datasetById = new Map(datasetRows.map(row => [row.question_id, runtimeRow(row)]));

  const missingDataset: string[] = [];
  const cases = (opts.limit ? results.slice(0, opts.limit) : results).filter(result => {
    if (!datasetById.has(result.id)) { missingDataset.push(result.id); return false; }
    return true;
  });

  const buckets = new Map<string, { cases: number; diffs: number; changedSessions: number; overlapSum: number }>();
  const order = ['≤12', '13-15', '16-20', '>20'];
  const bucketOf = (unique: number): string => (unique <= 12 ? '≤12' : unique <= 15 ? '13-15' : unique <= 20 ? '16-20' : '>20');
  const diffCases: Array<{ id: string; unique: number; removed: string[]; added: string[] }> = [];
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'c1-selection-parity-'));

  try {
    for (const result of cases) {
      const row = datasetById.get(result.id)!;
      const rendered = await renderCaseVault(row, tmpRoot);
      // Map recorded public-surface hits to the rebuilt vault by basename;
      // synthetic evidence hits ('_renor/evidence') resolve to nothing and are
      // skipped by the loader, exactly like unreadable paths at run time.
      const hits = result.hits.map(hit => {
        const base = path.basename(hit.notePath);
        const date = rendered.dateByBase.get(base);
        return date === undefined
          ? null
          : { notePath: path.join(rendered.vaultDir, 'Sessions', base), text: hit.text, session_date: date };
      }).filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      const unique = new Set(hits.map(hit => hit.notePath)).size;
      const bucket = bucketOf(unique);
      const stat = buckets.get(bucket) ?? { cases: 0, diffs: 0, changedSessions: 0, overlapSum: 0 };
      stat.cases += 1;

      if (unique > 12) {
        // Shipped selection (the run's recorded selections, reconstructed
        // deterministically from the recorded hits + rendered vault):
        const baseline = await loadEvidenceSessionsFromVault(hits, rendered.vaultDir, {
          maxSessions: opts.maxSessions, charCap: opts.charCap, bodyRank: false,
        });
        // Body-relevance candidate (RENOR_EVIDENCE_BODY_RANK=1):
        const query = `Question date: ${row.question_date}\n${row.question}`;
        const bodyRanked = await loadEvidenceSessionsFromVault(hits, rendered.vaultDir, {
          maxSessions: opts.maxSessions, charCap: opts.charCap, query, bodyRank: true,
        });
        const baseSet = new Set(baseline.map(s => path.basename(s.stem)));
        const bodySet = new Set(bodyRanked.map(s => path.basename(s.stem)));
        const removed = [...baseSet].filter(s => !bodySet.has(s));
        const added = [...bodySet].filter(s => !baseSet.has(s));
        const overlap = [...baseSet].filter(s => bodySet.has(s)).length;
        stat.overlapSum += overlap;
        if (removed.length > 0 || added.length > 0) {
          stat.diffs += 1;
          stat.changedSessions += Math.max(removed.length, added.length);
          diffCases.push({ id: result.id, unique, removed, added });
        }
      }
      buckets.set(bucket, stat);
    }
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }

  const sliceCases = [...buckets.entries()]
    .filter(([bucket]) => bucket !== '≤12')
    .reduce((sum, [, stat]) => sum + stat.cases, 0);
  const sliceDiffs = [...buckets.entries()]
    .filter(([bucket]) => bucket !== '≤12')
    .reduce((sum, [, stat]) => sum + stat.diffs, 0);

  console.log('C1 selection parity report (offline, zero model calls, gold-blind)');
  console.log(`  run dir:            ${runDir}`);
  console.log(`  dataset:            ${path.resolve(opts.dataset)}`);
  console.log(`  results compared:   ${cases.length}${missingDataset.length ? ` (${missingDataset.length} ids missing from dataset)` : ''}`);
  console.log('');
  console.log('  bucket        cases   with-diff   avg-overlap-of-12');
  for (const bucket of order) {
    const stat = buckets.get(bucket);
    if (!stat) continue;
    const avg = bucket === '≤12' ? 'n/a' : (stat.cases ? (stat.overlapSum / stat.cases).toFixed(2) : '0.00');
    console.log(`  ${bucket.padEnd(12)}  ${String(stat.cases).padStart(5)}   ${String(stat.diffs).padStart(10)}   ${avg}`);
  }
  console.log('');
  console.log(`  >12-unique-candidate slice: ${sliceCases} case(s), selection diffs: ${sliceDiffs}`);
  if (opts.verbose) {
    for (const diff of diffCases) {
      console.log(`\n  ${diff.id} (unique=${diff.unique})`);
      console.log(`    dropped by body rank: ${diff.removed.join(', ') || '(none)'}`);
      console.log(`    added by body rank:   ${diff.added.join(', ') || '(none)'}`);
    }
  }
  if (missingDataset.length) {
    console.error(`\n[warn] ${missingDataset.length} result id(s) not found in dataset: ${missingDataset.slice(0, 5).join(', ')}${missingDataset.length > 5 ? ' …' : ''}`);
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});