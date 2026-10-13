/**
 * Shared helpers for the SCR-C2-* write-path screens (component-matrix C2,
 * docs/evals/productization/C2-WRITE-PATH.md). Screens run through the REAL
 * indexVault() → factsWritePath → structured-row store path on real markdown
 * (H11-defect constraint): no offline artifacts, no sidecar injection, no
 * product-code changes. Screens measure the FLAG-ON path as shipped.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/schema';
import type { DecisionModel, DecisionResult } from '../../../src/extraction/decision-model';

export interface ScreenDb {
  db: Database.Database;
  dbPath: string;
  dir: string;
  close(): void;
}

/** Fresh temp SQLite database with all migrations (v1..v11) applied. */
export function freshScreenDb(tag: string): ScreenDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c2-screen-${tag}-`));
  const dbPath = path.join(dir, 'screen.db');
  const db = openDb(dbPath);
  runMigrations(db);
  return {
    db,
    dbPath,
    dir,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function sha256Of(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Deterministic dump of the structured_rows table (content only, id-ordered). */
/** Order-independent content fingerprint: identity → payload/dates/count (chunk/note ids excluded — concurrent indexing assigns them run-to-run). */
export function canonicalStructuredRows(db: Database.Database): { sha: string; count: number } {
  const rows = db
    .prepare(
      `SELECT row_kind, scope, dedupe_key, source_path, extraction_version, payload_json,
              valid_from, valid_to, confirm_count
       FROM structured_rows ORDER BY dedupe_key, source_path`
    )
    .all();
  return { sha: sha256Of(JSON.stringify(rows)), count: rows.length };
}

export function dumpStructuredRows(db: Database.Database): { sha: string; count: number } {
  const rows = db
    .prepare(
      `SELECT id, row_kind, scope, dedupe_key, source_path, source_chunk_id, source_hash,
              extraction_version, payload_json, valid_from, valid_to, confirm_count
       FROM structured_rows ORDER BY id`
    )
    .all();
  return { sha: sha256Of(JSON.stringify(rows)), count: rows.length };
}

export interface DecisionStats {
  calls: number;
  byTask: Record<string, number>;
  latencyMs: number[];
  costUSDCents: number;
}

/**
 * Timing/counting proxy around a DecisionModel — runner-side instrumentation
 * only; the wrapped model's decisions are unchanged (the screen measures the
 * shipped path, it does not alter it).
 */
export class InstrumentedDecisionModel implements DecisionModel {
  readonly calls: Array<{ task: string; decision: string; latencyMs: number }> = [];
  constructor(private readonly inner: DecisionModel) {}

  async decide(request: Parameters<DecisionModel['decide']>[0]): Promise<DecisionResult> {
    const result = await this.inner.decide(request);
    this.calls.push({ task: request.task, decision: String(result.decision), latencyMs: result.latencyMs });
    return result;
  }

  stats(): { calls: number; byTask: Record<string, number>; byDecision: Record<string, number>; latency: { p50: number; p95: number; max: number }; costUSDCentsTotal: number } {
    const byTask: Record<string, number> = {};
    const byDecision: Record<string, number> = {};
    const latencies: number[] = [];
    for (const c of this.calls) {
      byTask[c.task] = (byTask[c.task] ?? 0) + 1;
      byDecision[c.decision] = (byDecision[c.decision] ?? 0) + 1;
      latencies.push(c.latencyMs);
    }
    latencies.sort((a, b) => a - b);
    return {
      calls: this.calls.length,
      byTask,
      byDecision,
      latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? latencies[latencies.length - 1] : 0 },
      costUSDCentsTotal: 0, // local rules: zero cost by construction
    };
  }
}

/** Git HEAD sha + dirty state for the run manifest. */
export function gitState(): { sha: string; dirty: boolean } {
  const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  let dirty = false;
  try {
    execSync('git diff --quiet && git diff --cached --quiet');
  } catch {
    dirty = true;
  }
  return { sha, dirty };
}

export function writeJson(outPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(value, null, 2) + '\n');
}