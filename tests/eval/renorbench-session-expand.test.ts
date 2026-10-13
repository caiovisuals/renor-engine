import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';

/**
 * RenorBench (`eval:renor:hash`) fell from hit@10 0.9448 to 0.7853 when session expansion became the default
 * (RENOR_SESSION_EXPAND=5, the session-expansion default change). The expansion leaves the retrieval window
 * as it was and adds the short statements of its best notes; the newest-first layout puts them with their session,
 * so the scorer, which ranked the layout, counted them as ranked results and pushed the matches past position 10.
 * The product does not rank them: get_context lists them after every match, and search_memory gives them score 0, so by
 * score they follow every match. The runner ranks what the product presents: the matches in their order, then the
 * statements in theirs. Eval-hash embeddings: no network, no key, no model.
 */

const ENGINE_ROOT = path.resolve(__dirname, '../..');
/** RenorBench v1 dev, hash provider, before the expansion was the default (docs/evals/results/LEDGER.md, section H). */
const PRE_348_HIT_AT_10 = 0.9448;

type Hit = { notePath: string; text: string; score: number; reason?: string };
type Summary = Record<string, number>;

function run(expand: string | undefined): Promise<{ summary: Summary; results: Map<string, Hit[]> }> {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'renorbench-expand-'));
  fs.rmSync(output, { recursive: true });
  return new Promise((resolve, reject) => {
    // A whitelisted environment: no ambient key or provider setting reaches the runner; unset is the shipped default.
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/eval/run-renorbench.ts', '--provider', 'hash', '--allow-dirty', '--output', output], {
      cwd: ENGINE_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(expand === undefined ? {} : { RENOR_SESSION_EXPAND: expand }) },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error(`run-renorbench exited ${code}: ${stderr}`);
        const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8')).overall as Summary;
        const results = new Map(fs.readFileSync(path.join(output, 'results.jsonl'), 'utf8').trim().split('\n')
          .map(line => JSON.parse(line) as { id: string; hits: Hit[] })
          .map(row => [row.id, row.hits] as [string, Hit[]]));
        resolve({ summary, results });
      } catch (err) {
        reject(err);
      } finally {
        fs.rmSync(output, { recursive: true, force: true });
      }
    });
  });
}

const added = (hit: Hit) => hit.reason === SESSION_EXPAND_REASON;

describe('RenorBench ranks what the product presents when the session expansion is on', () => {
  it('scores the default at least as well as the expansion off and the pre-#348 record, with the window untouched', async () => {
    const off = await run('0');
    const on = await run(undefined);

    // Guard against passing on nothing: the default really adds statements, and the off arm adds none.
    expect([...on.results.values()].some(hits => hits.some(added))).toBe(true);
    expect([...off.results.values()].some(hits => hits.some(added))).toBe(false);

    expect(off.summary.hitAt10).toBeGreaterThanOrEqual(PRE_348_HIT_AT_10);
    expect(on.summary.hitAt10).toBeGreaterThanOrEqual(PRE_348_HIT_AT_10);
    for (const metric of ['hitAt1', 'hitAt5', 'hitAt10', 'recallAt5', 'recallAt10', 'recallAllAt5', 'recallAllAt10', 'mrr', 'ndcgAt5', 'ndcgAt10']) {
      expect(on.summary[metric], metric).toBeGreaterThanOrEqual(off.summary[metric]);
    }

    for (const [id, hits] of on.results) {
      // The expansion only adds: the matches are the off arm's hits, in the same order.
      expect(hits.filter(hit => !added(hit)), id).toEqual(off.results.get(id));
      // And it is ranked after every match.
      const firstAdded = hits.findIndex(added);
      if (firstAdded >= 0) expect(hits.slice(firstAdded).every(added), `${id}: a statement ranked before a match`).toBe(true);
    }
  }, 180_000);
});
