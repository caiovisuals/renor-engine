import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexFile } from '../../src/indexer/pipeline';
import {
  LocalRulesDecisionModel,
  defaultDecisionModel,
  type DecisionModel,
  type DecisionRequest,
  type DecisionResult,
} from '../../src/extraction/decision-model';
import type { ExtractedNumericFact } from '../../src/extraction/typedFacts';
import type { ExtractedEvent } from '../../src/extraction/eventExtractor';
import type Database from 'better-sqlite3';

/**
 * C2 harmonization integration fixtures (merge of the fleet extractors
 * #126/#127/#130 with the DecisionModel write path): extractor candidates →
 * DecisionModel decisions → rows written AT MOST ONCE; the sensitivity
 * guardrail blocks synthetic secrets end-to-end; lane ownership keeps one
 * candidate generator per lane.
 */

const tmpDirs: string[] = [];
function mkvault(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-harmonization-'));
  tmpDirs.push(d);
  return d;
}
function freshDb(file: string): Database.Database {
  // MUST be openDb(): PRAGMA foreign_keys=ON lives only here (cascade fixtures).
  const db = openDb(file);
  runMigrations(db);
  return db;
}
afterEach(() => {
  LANE_FLAGS.forEach((f, i) => {
    if (ORIGINAL_FLAGS[i] === undefined) delete process.env[f];
    else process.env[f] = ORIGINAL_FLAGS[i];
  });
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function writeNote(v: string, name: string, content: string): Promise<string> {
  const p = path.join(v, name);
  fs.writeFileSync(p, content);
  return p;
}

/** Spy wrapper: records every seam decision, delegates to local rules (or a stub). */
class SpyDecisionModel implements DecisionModel {
  readonly calls: DecisionRequest[] = [];
  constructor(private readonly delegate: DecisionModel = new LocalRulesDecisionModel()) {}
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push(request);
    return this.delegate.decide(request);
  }
  gateCalls(): number {
    return this.calls.filter((c) => c.task === 'capture_gate').length;
  }
  dedupeCalls(): number {
    return this.calls.filter((c) => c.task === 'dedupe_adjudication').length;
  }
}

/** Synthetic sensitivity guardrail: blocks any span carrying the planted token. */
class GuardrailStubModel implements DecisionModel {
  readonly calls: DecisionRequest[] = [];
  constructor(private readonly secretMarker: string) {}
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push(request);
    if (request.task === 'capture_gate' && request.text.includes(this.secretMarker)) {
      // Same seam shape the Jev guardrail adapter uses: block → 'sensitive'.
      return {
        task: 'capture_gate',
        decision: 'sensitive',
        confidence: 1,
        latencyMs: 0,
        costUSDCents: 0,
      };
    }
    return new LocalRulesDecisionModel().decide(request);
  }
}

/**
 * Both lane flags are read from the REAL process environment: indexFile has
 * no env-injection parameter, so this file arms the variables `renor index`
 * reads and restores them after every test.
 */
const LANE_FLAGS = ['RENOR_TYPED_FACTS', 'RENOR_CHRONICLE'] as const;
const ORIGINAL_FLAGS = LANE_FLAGS.map((f) => process.env[f]);
beforeEach(() => { for (const f of LANE_FLAGS) process.env[f] = '1'; });

function factStub(facts: ExtractedNumericFact[], calls: { n: number }) {
  return async (): Promise<ExtractedNumericFact[]> => {
    calls.n++;
    return facts;
  };
}

const NOTE = `---
kind: session
session_date: 2026-03-10
---
# Training log

Ran 21.1 km today.
`;

describe('harmonized write path: extractor candidates → DecisionModel decisions → rows written once', () => {
  it('RENOR_TYPED_FACTS: candidates flow through the seam (capture-gate + dedupe decisions) and each candidate writes at most one row', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', NOTE);
    const calls = { n: 0 };
    const model = new SpyDecisionModel();
    await indexFile(db, note, {
      numericFactExtractor: factStub(
        [{ value: '21.1', unit: 'km', verb: 'ran', object: 'long run' }],
        calls,
      ),
      decisionModel: model,
    });

    // decisions BEFORE writes: one capture-gate + one dedupe adjudication per candidate
    expect(model.gateCalls()).toBe(1);
    expect(model.dedupeCalls()).toBe(1);
    // single write: exactly one row, fleet provenance preserved
    const rows = db.prepare(
      `SELECT row_kind, extraction_version, payload_json, confirm_count FROM structured_rows`,
    ).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].row_kind).toBe('fact');
    expect(rows[0].extraction_version).toContain('facts-v1'); // fleet's FACTS_EXTRACTION_VERSION stays in the row
    expect(JSON.parse(rows[0].payload_json).value).toBe('21.1');
    expect(rows[0].confirm_count).toBe(1);

    // unchanged content: hash-keyed skip → zero extractor calls, zero decisions
    const before = model.calls.length;
    await indexFile(db, note, {
      numericFactExtractor: factStub([{ value: '21.1', object: 'long run' }], calls),
      decisionModel: model,
    });
    expect(calls.n).toBe(1);
    expect(model.calls.length).toBe(before);
    db.close();
  });

  it('guardrail blocks synthetic secrets end-to-end: a sensitive capture-gate decision writes zero rows', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const secretNote = await writeNote(v, 'secret.md', `---
session_date: 2026-03-10
---
# Credentials

My api key is PLANTED_SECRET_TOKEN_123456 and it is 32 characters long.
`);
    const benignNote = await writeNote(v, 'benign.md', `---
session_date: 2026-03-10
---
# Training log

Ran 21.1 km today.
`);
    const calls = { n: 0 };
    const model = new GuardrailStubModel('PLANTED_SECRET_TOKEN');
    await indexFile(db, secretNote, {
      numericFactExtractor: factStub(
        [{ value: '32', unit: 'characters', verb: 'expires', object: 'planted secret token' }],
        calls,
      ),
      decisionModel: model,
    });
    await indexFile(db, benignNote, {
      numericFactExtractor: factStub(
        [{ value: '21.1', unit: 'km', verb: 'ran', object: 'long run' }],
        calls,
      ),
      decisionModel: model,
    });

    // the secret-bearing candidate never became a row; the benign one did
    const rows = db.prepare('SELECT source_path, payload_json FROM structured_rows').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source_path).toBe(benignNote);
    expect(rows.some((r) => r.source_path === secretNote)).toBe(false);
    // the guardrail decision flowed through the seam for BOTH notes' candidates
    const gates = model.calls.filter((c) => c.task === 'capture_gate');
    expect(gates.length).toBe(2);
    db.close();
  });

  it('cross-note identical fleet-lane facts keep the confirm-count + coexist semantics (review FIX 1) with fleet provenance', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const model = new SpyDecisionModel();
    const calls = { n: 0 };
    const opts = (value: string) => ({
      numericFactExtractor: factStub([{ value, unit: 'km', verb: 'ran', object: 'long run' }], calls),
      decisionModel: model,
    });
    const a = await writeNote(v, '2026-03-10.md', NOTE.replace('21.1 km', '21.1 km'));
    await indexFile(db, a, opts('21.1'));
    const b = await writeNote(v, '2026-06-01.md', NOTE.replace('Ran 21.1 km today', 'Ran 21.1 km today again'));
    await indexFile(db, b, opts('21.1'));

    const rows = db.prepare(
      `SELECT source_path, confirm_count, extraction_version FROM structured_rows ORDER BY id`,
    ).all() as any[];
    expect(rows).toHaveLength(2); // identical: bump + cross-note coexist write — no duplicate identity
    expect(rows[0].confirm_count).toBe(2); // the original row was corroborated
    expect(rows[1].source_path).toBe(b);
    for (const r of rows) expect(r.extraction_version).toContain('facts-v1');
    expect(model.dedupeCalls()).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it('single write path: RENOR_FACTS_WRITE_PATH stands down when the typed-facts lane is armed (no double extraction)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', NOTE);
    const calls = { n: 0 };
    const model = new SpyDecisionModel();
    await indexFile(db, note, {
      numericFactExtractor: factStub(
        [{ value: '21.1', unit: 'km', verb: 'ran', object: 'long run' }],
        calls,
      ),
      decisionModel: model,
    });

    // Both fact generators armed: the fleet lane is THE fact lane; the local
    // rules capture lane stands down, so exactly one row version exists.
    process.env.RENOR_FACTS_WRITE_PATH = '1';
    try {
      const note2 = await writeNote(v, 'run2.md', NOTE);
      await indexFile(db, note2, {
        numericFactExtractor: factStub(
          [{ value: '21.1', unit: 'km', verb: 'ran', object: 'long run' }],
          calls,
        ),
        decisionModel: model,
      });
      const versions = db.prepare(
        'SELECT DISTINCT extraction_version FROM structured_rows',
      ).all() as any[];
      expect(versions).toHaveLength(1);
      expect(versions[0].extraction_version).toContain('facts-v1');
      expect(
        (db.prepare("SELECT count(*) c FROM structured_rows WHERE extraction_version = 'c2-facts-v1'").get() as any).c,
      ).toBe(0);
    } finally {
      delete process.env.RENOR_FACTS_WRITE_PATH;
    }
    db.close();
  });

  it('RENOR_FACTS_WRITE_PATH alone is unchanged: local-rules capture with the seam (this branch behavior preserved)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const note = await writeNote(v, 'run.md', NOTE);
    const model = new SpyDecisionModel();
    process.env.RENOR_FACTS_WRITE_PATH = '1';
    try {
      await indexFile(db, note, { decisionModel: model });
    } finally {
      delete process.env.RENOR_FACTS_WRITE_PATH;
    }

    const rows = db.prepare('SELECT extraction_version, payload_json FROM structured_rows').all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.extraction_version).toBe('c2-facts-v1');
    expect(model.gateCalls()).toBeGreaterThan(0); // per-chunk capture gate ran through the seam
    db.close();
  });

  it('RENOR_CHRONICLE: event candidates flow through the seam; identical restatement supersedes via identity (fleet semantics kept)', async () => {
    const v = mkvault();
    const db = freshDb(path.join(v, 'index.db'));
    const model = new SpyDecisionModel();
    const eventStub = async (): Promise<ExtractedEvent[]> => [{ when: 'yesterday', event: 'ran 5km' }];
    const older = await writeNote(v, '2026-03-10.md', `---
kind: session
session_date: 2026-03-10
---
# Run log

I ran 5km yesterday.
`);
    const newer = await writeNote(v, '2026-06-01.md', `---
kind: session
session_date: 2026-06-01
---
# Run log again

As I said: I ran 5km yesterday.
`);
    const opts = { eventExtractor: eventStub, decisionModel: model };
    await indexFile(db, older, opts);
    await indexFile(db, newer, opts);

    expect(model.gateCalls()).toBe(2); // one per note's candidate, through the seam
    const rows = db.prepare(
      'SELECT source_path, valid_to, extraction_version FROM structured_rows WHERE row_kind = \'event\' ORDER BY valid_from',
    ).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].valid_to).toBe('2026-06-01'); // superseded — fleet bitemporal semantics kept
    expect(rows[1].valid_to).toBeNull();
    for (const r of rows) expect(r.extraction_version).toContain('events-v1');
    db.close();
  });
});
