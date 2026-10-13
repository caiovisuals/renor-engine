import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSION_EXPAND_REASON } from '../../src/retrieval/orchestrator';

/**
 * What both RenorBench arms must prepare identically, so that their scores are about the same data at the same
 * moment: the fixture identity, the vault's note ages, the frozen clock, and the order a reply is read in. The
 * chunk arm (run-renorbench.ts) and the product arm (run-renorbench-product.ts) import it; an arm that kept its own
 * copy could drift from the other and make the two scores incomparable without any manifest saying so.
 */

export interface FixtureMeta {
  version: number;
  description?: string;
  relativeMtimeDays?: Record<string, number>;
  /** Vault paths deleted after the first indexing pass, followed by a fresh
   * rebuild — deletion/erasure cases must not resurface from the rebuild. */
  deleteAfterIndex?: string[];
}

/** Frozen evaluation clock: fixture recency is deterministic and independent
 * of wall-clock time or run duration (independent-review finding). */
export const EVAL_NOW = Date.parse('2026-01-01T00:00:00Z');

export function readJsonl<T>(filePath: string): T[] {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

export function jsonl(rows: unknown[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

export function sha256Buffer(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function hashFixture(root: string): Promise<string> {
  return sha256Buffer(`${sha256Buffer(await fsp.readFile(path.join(root, 'fixture.json')))}\0${await hashTree(path.join(root, 'vault'))}`);
}

async function hashTree(root: string): Promise<string> {
  const parts: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replaceAll(path.sep, '/');
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        parts.push(`${rel}\0${sha256Buffer(await fsp.readFile(full))}`);
      }
    }
  }
  await walk(root);
  return sha256Buffer(parts.join('\n'));
}

export async function applyRelativeMtimes(vaultDir: string, fixtureMeta: FixtureMeta): Promise<void> {
  const agePaths = Object.keys(fixtureMeta.relativeMtimeDays ?? {});
  const now = EVAL_NOW;
  // Every note needs an explicit age: checkout/copy time must not influence
  // recency ranking (independent-review finding).
  async function check(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await check(full);
      else if (entry.name.endsWith('.md')
          && !agePaths.includes(path.relative(vaultDir, full).replaceAll(path.sep, '/'))) {
        throw new Error(`Missing fixture mtime: ${full}`);
      }
    }
  }
  await check(vaultDir);
  for (const [relativePath, ageDays] of Object.entries(fixtureMeta.relativeMtimeDays ?? {})) {
    if (!Number.isFinite(ageDays) || ageDays < 0) throw new Error(`Invalid fixture age: ${relativePath}`);
    const target = path.resolve(vaultDir, relativePath);
    const root = path.resolve(vaultDir);
    if (!(target === root || target.startsWith(root + path.sep))) {
      throw new Error(`Fixture mtime path escapes vault: ${relativePath}`);
    }
    const stamp = new Date(now - ageDays * 86_400_000);
    await fsp.utimes(target, stamp, stamp);
  }
}

/**
 * The order the scorer ranks: what the product presents as ranked. Session expansion (RENOR_SESSION_EXPAND, default
 * five notes) adds the short statements of the window's best notes to it without touching the window, and lays each
 * out with its session, so a statement can sit between two matches. No product surface ranks it there: get_context
 * lists the statements after every match (mvp/agentMemory.ts applyBudget), and search_memory gives them score 0 and
 * says to judge a hit by its score, never by its position, so by score they follow every match. Ranking the layout counted
 * them as ranked results and pushed matches past position 10: hit@10 0.9448 -> 0.7853 at #348, with every match still
 * in both replies. So the matches are ranked in their order, then the statements in theirs. A statement still earns
 * credit where it is the evidence, and still counts in contextTokens. With the expansion off there is no statement
 * and the order is the layout's, unchanged.
 */
export function rankedAsPresented<T extends { reason?: string }>(hits: T[]): T[] {
  return [...hits.filter(hit => hit.reason !== SESSION_EXPAND_REASON), ...hits.filter(hit => hit.reason === SESSION_EXPAND_REASON)];
}
