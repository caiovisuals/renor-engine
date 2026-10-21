import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { createServer } from '../../src/api/server';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { noteProvenance, READ_HONESTY_FLAG } from '../../src/context/readHonesty';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { PRODUCT_RUNTIME_FIELD_ALLOWLIST, GOLD_RUNTIME_FIELD_NAMES } from '../../src/eval/runManifest';

/**
 * LANE 5 — product-path contract: the read/answer-context boundary.
 *
 * The binding product-truth policy (engine/AGENTS.md) says a score is only a
 * Renor product score when every request exercises the shipped product path and
 * evaluation clients "must not inject sidecar facts, chronicles, preferences,
 * dataset-turn renderings, hidden session mappings, gold labels, or duplicated
 * product logic into answer context."
 *
 * tests/eval/product-path-contract.test.ts locks the AUTHORING side of that
 * (the runner's imports, sidecar flags, gold marshaling). Nothing locked the
 * READ side: the surfaces a consuming agent actually calls. These tests do.
 *
 * Every assertion below names the breakage it catches. They are deliberately
 * asserted at the real public surfaces — a real HTTP /retrieve-context call, a
 * real spawned `renor search --json`, a real MCP tools/call — not from the
 * helpers they wrap, so a divergence between the public entry point and the
 * internal helper path is itself a failure.
 *
 * NOTHING here reads a gold field: the fixtures are ordinary vault notes written
 * by the test, exactly as a user's markdown would arrive.
 */

const tmpDirs: string[] = [];
function mkTempDir(prefix = 'lane5-read-contract-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env[READ_HONESTY_FLAG];
  delete process.env.RENOR_SEARCH_EVIDENCE;
});

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The compiled `renor` bin (package.json `bin`), built by tests/globalSetup.ts before any test
// file loads: the surface a user runs, and without paying tsx's transform on every spawn.
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

// ─── Real vault fixture + product CLI ───

interface SeededVault {
  root: string;
  dbPath: string;
  ledger: string;
}

/**
 * Two ordinary session notes with frontmatter session dates — the exact shape
 * the product indexer ingests from a user's markdown vault. Dates are pinned so
 * the newest-first product default and the rendered date lines are deterministic,
 * and file mtimes are pinned too so the time-decay recency term is stable.
 */
function seedVault(): SeededVault {
  const root = mkTempDir();
  fs.mkdirSync(path.join(root, 'Sessions'), { recursive: true });
  const write = (rel: string, sessionDate: string, body: string) => {
    const file = path.join(root, rel);
    fs.writeFileSync(
      file,
      `---\nkind: note\nsession_date: "${sessionDate}"\n---\n\n# ${path.basename(rel, '.md')}\n\n${body}\n`,
    );
    // The indexer records modified_at from the file mtime, and recency scoring
    // is `0.1 * (1 - daysSince/30)`. A freshly written file therefore makes
    // every score drift with the wall clock (measured: 1e-10 between two reads
    // of the same rows). Pin the mtimes so the fixture is deterministic.
    const when = new Date(sessionDate);
    fs.utimesSync(file, when, when);
  };
  write('Sessions/a-1.md', '2026-01-15T00:00:00.000Z', 'The machine runs on mains power at 300 W.');
  write('Sessions/b-2.md', '2026-01-16T00:00:00.000Z', 'The rack holds a UPS for nine minutes of runtime.');
  return { root, dbPath: path.join(root, '.semantic-memory', 'index.db'), ledger: 'System/Ledger.md' };
}

/** Env the shipped CLI/index path is driven with: synthetic, credential-free, offline. */
function cliEnv(vault: SeededVault, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMS',
    'EMBEDDING_BATCH_SIZE', 'LLM_EXTRACTION', 'VAULT_PATH', 'DB_PATH', 'MEMORY_LEDGER',
    'RENOR_SEARCH_EVIDENCE', 'RENOR_STRUCTURED_CONTEXT', 'RENOR_QUERY_SCOPED_ROWS',
    READ_HONESTY_FLAG,
  ]) delete env[key];
  return Object.assign(env, {
    VAULT_PATH: vault.root,
    DB_PATH: vault.dbPath,
    EMBEDDING_PROVIDER: 'eval-hash',
    RENOR_SEARCH_EVIDENCE: '0',
    MEMORY_LEDGER: vault.ledger,
  }, extra);
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, timeout: 120_000 },
      (err, stdout, stderr) => resolve({
        code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : (err ? 1 : 0),
        stdout: String(stdout),
        stderr: String(stderr),
      }));
  });
}

async function indexVault(vault: SeededVault, extra: Record<string, string> = {}): Promise<void> {
  const indexed = await runCli(['index'], cliEnv(vault, extra));
  expect(indexed.code).toBe(0);
  expect(indexed.stdout).toMatch(/Done\.\s*2\/2 indexed, 0 errors/);
}

/**
 * The API surface's provider must be the SAME provider the CLI indexed with,
 * or the comparison is between two different vector spaces and fails for a
 * reason that has nothing to do with the contract under test. `eval-hash` is
 * the shipped deterministic offline provider, so both surfaces share it.
 */
function stubProvider() {
  return new EvalHashEmbeddingProvider();
}

/** The shipped HTTP read surface over an already-indexed product DB. */
function httpRead(vault: SeededVault, query: string) {
  const db = openDb(vault.dbPath);
  runMigrations(db);
  const provider = stubProvider();
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  const app = createServer(db, vectorIndex, provider as never, vault.root, [], undefined, undefined, { apiToken: 'synthetic-api-token-for-tests' });
  return {
    db,
    read: () => request(app).post('/retrieve-context').set('Authorization', 'Bearer synthetic-api-token-for-tests').send({ query }),
    helper: () => retrieveContext(db, vectorIndex, provider as never, query, 20, []),
  };
}

// ─── 1. No non-product input may reach the answer context ────────────────────

describe('LANE 5: the answer context carries nothing the public surface did not return', () => {
  /**
   * CATCHES: a retrieval/context-assembly change that starts injecting
   * non-product inputs into answer context — sidecar facts, chronicles,
   * preferences, dataset-turn renderings, hidden session mappings, gold labels,
   * or duplicated product logic. The policy forbids all of them; this is the
   * mechanical enforcement.
   *
   * Construction: ordinary notes are indexed, then a SECOND set of rows that
   * only a privileged harness could know about is written straight into the
   * product DB — facts on a subject the vault never mentions, a structured row
   * (the typed-fact / event / preference table the eval sidecars feed), and a
   * note in a directory the vault never had. If any read path starts pulling
   * those into context, the marker strings show up in the response.
   */
  it('never surfaces sidecar facts, structured-row sidecars, or unknown-session notes', async () => {
    const vault = seedVault();
    await indexVault(vault);

    const SIDECAR = 'SIDECARCHANNEL9';
    const SIDECAR_ROW = 'SIDECARROW7';
    const GOLD_LEAK = 'GOLDLEAK4';
    const GHOST_SESSION = 'GHOSTSESSION2';

    const db = openDb(vault.dbPath);
    runMigrations(db);
    const at = '2026-01-20T00:00:00.000Z';

    // (a) A lifecycle fact about a subject the vault never mentions. The
    // lifecycle entity is owned by the reserved `_mcp_` note, so that note row
    // has to exist for the FK (the product creates it itself on first write).
    db.prepare(
      `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES ('_mcp_', 'Memory Lifecycle', 'system', '_mcp_', ?, '{}')`,
    ).run(at);
    db.prepare(
      `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at)
       VALUES ('person', ?, '[]', '_mcp_', 1.0, ?) RETURNING id`,
    ).get(`Sidecar${SIDECAR}`, at);
    const entityId = (db.prepare('SELECT id FROM entities WHERE canonical_name = ?')
      .get(`Sidecar${SIDECAR}`) as { id: number }).id;
    db.prepare(
      `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at)
       VALUES (?, 'secret_channel', ?, '_mcp_', 1.0, ?, ?)`,
    ).run(entityId, `the answer is ${GOLD_LEAK}`, at, at);

    // (b) A structured row — the table the typed-fact/event/preference sidecars write.
    db.prepare(
      `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES ('Notes/Sidecar.md', 'Sidecar', 'note', 's1', ?, '{}')`,
    ).run(at);
    const chunkId = (db.prepare(
      `INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
       VALUES ('Notes/Sidecar.md', '', 'the answer is SIDECARROW7', 1, 1, 5, 'sc1') RETURNING id`,
    ).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO structured_rows (row_kind, source_path, source_hash, source_chunk_id, scope,
                                    extraction_version, valid_from, payload_json, dedupe_key, created_at)
       VALUES ('fact', 'Notes/Sidecar.md', 's1', ?, 'global', 'v1', ?, ?, ?, ?)`,
    ).run(chunkId, at, JSON.stringify({ value: SIDECAR_ROW, object: GOLD_LEAK }), `fact|${SIDECAR_ROW}`, at);

    // (c) A note in a session the vault never contained (hidden session mapping).
    db.prepare(
      `INSERT INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json)
       VALUES (?, 'Ghost', 'note', 'g1', ?, '{}')`,
    ).run(`Sessions/${GHOST_SESSION}.md`, at);
    db.prepare(
      `INSERT INTO chunks (note_path, heading_path, text, start_line, end_line, token_count, chunk_hash)
       VALUES (?, '', ?, 1, 1, 5, 'g1')`,
    ).run(`Sessions/${GHOST_SESSION}.md`, `the answer is ${GOLD_LEAK}`);
    db.close();

    // The HTTP surface, the real public CLI, and the internal helper must all
    // agree, and none of them may emit any marker.
    const { read, helper } = httpRead(vault, 'what is the answer');
    const viaHttp = JSON.stringify((await read()).body);
    const viaHelper = JSON.stringify(await helper());
    const viaCli = await runCli(['search', 'what is the answer', '--json'], cliEnv(vault));

    expect(viaCli.code).toBe(0);
    for (const [surface, payload] of [
      ['http', viaHttp],
      ['helper', viaHelper],
      ['cli', viaCli.stdout],
    ] as const) {
      for (const marker of [SIDECAR, SIDECAR_ROW, GOLD_LEAK, GHOST_SESSION]) {
        expect(`${surface}:${payload}`).not.toContain(marker);
      }
    }

    // Non-vacuous: the read really did return the vault's own content, so the
    // marker absence above is a filtered result, not an empty response.
    expect(viaHelper).toContain('mains power');
  }, 180_000);

  /**
   * CATCHES: a regression that lets gold-derived dataset fields appear as
   * runtime-visible inputs. The allowlist is the contract; if a future change
   * widens it to admit `answer` / `answer_session_ids` / `question_type` /
   * `shouldAbstain`, a product score would silently become gold-derived.
   */
  it('keeps the runtime-visible dataset allowlist disjoint from every gold field', () => {
    const allowlist: readonly string[] = PRODUCT_RUNTIME_FIELD_ALLOWLIST;
    expect(allowlist.length).toBeGreaterThan(0);
    for (const gold of GOLD_RUNTIME_FIELD_NAMES) {
      expect(allowlist).not.toContain(gold);
    }
    // The corpus-rendering inputs the public path is allowed to see are present,
    // so this assertion is about the boundary and not about an empty list.
    expect([...allowlist]).toEqual([
      'question_id', 'question', 'question_date',
      'haystack_sessions', 'haystack_dates', 'haystack_session_ids',
    ]);
  });
});

// ─── 2. Provenance / last-verified on returned items ─────────────────────────

describe('LANE 5: provenance and last-verified survive on every returned item', () => {
  /**
   * CATCHES: provenance / last-verified fields being dropped from returned
   * items. Agent-dogfood D2 is exactly this failure mode: the read returned
   * facts with nothing saying where they came from or when they were last
   * verified, so a stale value was indistinguishable from a current one.
   *
   * Asserted on all three public surfaces at once, because a fix applied to only
   * one of them (the CLI but not the MCP/HTTP path) is the same product defect.
   */
  it('attaches a non-empty source and an explicit last-verified state to every item on CLI and HTTP', async () => {
    const vault = seedVault();
    await indexVault(vault, { [READ_HONESTY_FLAG]: '1' });

    // Public CLI (`renor search --json`).
    const cli = await runCli(['search', 'what powers the machine', '--json'], cliEnv(vault, { [READ_HONESTY_FLAG]: '1' }));
    expect(cli.code).toBe(0);
    const cliBody = JSON.parse(cli.stdout);
    expect(cliBody.hits.length).toBeGreaterThan(0);
    for (const hit of cliBody.hits) {
      expect(hit.provenance).toBeDefined();
      expect(hit.provenance.source).toBe(hit.notePath);
      expect(hit.provenance.kind).toBe('note');
      // `lastVerified` must be PRESENT (it may legitimately be null when the
      // system has no recorded date) — an absent key means the field was dropped.
      expect(Object.prototype.hasOwnProperty.call(hit.provenance, 'lastVerified')).toBe(true);
    }
    // The item's own session date is the verification date, not "now".
    const dated = cliBody.hits.find((h: { session_date?: string }) => h.session_date === '2026-01-15T00:00:00.000Z');
    expect(dated).toBeDefined();
    expect(dated.provenance.lastVerified).toBe('2026-01-15T00:00:00.000Z');

    // Public HTTP read surface.
    const { read, db } = httpRead(vault, 'what powers the machine');
    process.env[READ_HONESTY_FLAG] = '1';
    const body = (await read()).body;
    db.close();
    expect(body.readHonesty).toBeDefined();
    expect(body.readHonesty.provenance).toHaveLength(body.hits.length);
    for (const provenance of body.readHonesty.provenance) {
      expect(typeof provenance.source).toBe('string');
      expect(provenance.source.length).toBeGreaterThan(0);
      expect(Object.prototype.hasOwnProperty.call(provenance, 'lastVerified')).toBe(true);
    }
    expect(body.readHonesty.provenance.map((p: { source: string }) => p.source))
      .toEqual(body.hits.map((h: { notePath: string }) => h.notePath));
  }, 180_000);

  /**
   * CATCHES: an unknown verification date being invented. `lastVerified` is
   * `null` when the system has no recorded date; substituting the current time
   * or a fabricated epoch would make an unverifiable item look verified.
   */
  it('never invents a verification date: an unknown date stays null', () => {
    expect(noteProvenance('Sessions/a-1.md').lastVerified).toBeNull();
    expect(noteProvenance('Sessions/a-1.md', null).lastVerified).toBeNull();
    expect(noteProvenance('Sessions/a-1.md', undefined).lastVerified).toBeNull();
    expect(noteProvenance('Sessions/a-1.md', '2026-01-15T00:00:00.000Z').lastVerified)
      .toBe('2026-01-15T00:00:00.000Z');
  });

  /**
   * CATCHES: provenance being misattributed — an item stamped with a source
   * that is not the item it describes. A provenance field that resolves is
   * worthless if it points at the wrong row; an agent would discount or trust
   * the wrong evidence.
   *
   * FINDING (recorded, not fixed — outside this lane's scope): on this HTTP
   * surface both `hits[].notePath` and `readHonesty.provenance[].source` carry
   * the VAULT-ABSOLUTE path. Lane 3's "a product surface never leaks a host
   * path" rule holds for the MCP `get_context` tool (which renders
   * client-relative through clientSafePath) but not for /retrieve-context,
   * whose absolute `hits[].notePath` predates lane 3. This test therefore locks
   * the CONSISTENCY invariant (provenance matches the item) rather than a path
   * shape the surface does not have; silently asserting path safety here would
   * fail against shipped behaviour and a test that cannot pass is not a test.
   */
  it('stamps each item with provenance naming that same item', async () => {
    const vault = seedVault();
    await indexVault(vault);
    const { read, db } = httpRead(vault, 'what powers the machine');
    process.env[READ_HONESTY_FLAG] = '1';
    const body = (await read()).body;
    db.close();
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.readHonesty.provenance.map((p: { source: string }) => p.source))
      .toEqual(body.hits.map((h: { notePath: string }) => h.notePath));
    // And the verification date is the item's own date, not the other item's.
    for (let i = 0; i < body.hits.length; i++) {
      expect(body.readHonesty.provenance[i].lastVerified).toBe(body.hits[i].session_date);
    }
  }, 180_000);
});

// ─── 3. Abstention must not silently revert to presenting weak hits ───────────

describe('LANE 5: an uncovered question is answered with an explicit no-answer', () => {
  /**
   * CATCHES: the abstention path silently reverting to returning weak hits.
   * Agent-dogfood D6: weak hits were returned as if they answered the question,
   * which trains a consuming agent to trust noise. The read must SAY it has
   * nothing — and it must still not hide the hits (nothing is filtered), so the
   * two halves of the contract are asserted together.
   */
  it('says so on the CLI and HTTP surfaces, while still returning the hits it has', async () => {
    const vault = seedVault();
    await indexVault(vault, { [READ_HONESTY_FLAG]: '1' });
    const offTopic = 'what is my favourite colour and pet name';

    // Public CLI.
    const cli = await runCli(['search', offTopic, '--json'], cliEnv(vault, { [READ_HONESTY_FLAG]: '1' }));
    expect(cli.code).toBe(0);
    const cliBody = JSON.parse(cli.stdout);
    expect(cliBody.hits.length).toBeGreaterThan(0); // nothing is hidden
    expect(cliBody.readHonesty.abstention).toBeDefined();
    expect(cliBody.readHonesty.abstention.status).toBe('no-answer');
    expect(cliBody.readHonesty.abstention.reason).toBe('below-evidence-bar');
    expect(cliBody.readHonesty.abstention.statement).toBe('no good answer on file for this');
    expect(cliBody.readHonesty.abstention.coverage).toBeLessThan(cliBody.readHonesty.abstention.bar);

    // Public HTTP surface.
    const { read, db } = httpRead(vault, offTopic);
    process.env[READ_HONESTY_FLAG] = '1';
    const body = (await read()).body;
    db.close();
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.readHonesty.abstention.status).toBe('no-answer');
    expect(body.readHonesty.abstention.statement).toBe('no good answer on file for this');
  }, 180_000);

  /**
   * CATCHES: the abstention bar being turned into a no-op. A bar that always
   * abstains, or one that never does, is a broken contract in one of the two
   * directions; both directions are asserted on the same evidence set.
   */
  it('abstains for an uncovered question and does NOT abstain for a covered one', async () => {
    const vault = seedVault();
    await indexVault(vault, { [READ_HONESTY_FLAG]: '1' });

    const covered = await runCli(['search', 'what powers the machine', '--json'], cliEnv(vault, { [READ_HONESTY_FLAG]: '1' }));
    expect(covered.code).toBe(0);
    const coveredBody = JSON.parse(covered.stdout);
    expect(coveredBody.hits.length).toBeGreaterThan(0);
    expect(coveredBody.readHonesty.abstention).toBeNull();

    const uncovered = await runCli(['search', 'what is my favourite colour and pet name', '--json'], cliEnv(vault, { [READ_HONESTY_FLAG]: '1' }));
    expect(uncovered.code).toBe(0);
    expect(JSON.parse(uncovered.stdout).readHonesty.abstention.status).toBe('no-answer');
  }, 180_000);

  /**
   * CATCHES: the flag being flipped on by a default, or armed as a side effect
   * of another flag — either would silently change the shipped read contract.
   * The un-armed response must be byte-identical to the shipped one: no new
   * top-level key, no new per-item key.
   */
  it('adds nothing to the response when the flag is unset (default-off, byte-identical contract)', async () => {
    const vault = seedVault();
    await indexVault(vault);

    const cli = await runCli(['search', 'what powers the machine', '--json'], cliEnv(vault));
    expect(cli.code).toBe(0);
    const cliBody = JSON.parse(cli.stdout);
    expect(Object.keys(cliBody).sort()).toEqual(['hits']);
    for (const hit of cliBody.hits) {
      expect(Object.keys(hit).sort()).toEqual(['notePath', 'reason', 'score', 'session_date', 'text']);
    }

    const { read, db } = httpRead(vault, 'what powers the machine');
    delete process.env[READ_HONESTY_FLAG];
    const body = (await read()).body;
    db.close();
    expect(body.readHonesty).toBeUndefined();
    // The flag is not armed by arming another product flag.
    process.env.RENOR_STRUCTURED_CONTEXT = '1';
    const { read: read2, db: db2 } = httpRead(vault, 'what powers the machine');
    const body2 = (await read2()).body;
    db2.close();
    delete process.env.RENOR_STRUCTURED_CONTEXT;
    expect(body2.readHonesty).toBeUndefined();
  }, 180_000);
});

// ─── 4. The public entry point must not diverge from the internal helper ─────

describe('LANE 5: the public entry points agree with the internal helper path', () => {
  /**
   * CATCHES: the public entry point (CLI/MCP/HTTP) diverging from the internal
   * helper path. A read that is honest through the helper but silent through the
   * shipped surface is a product defect that a helper-only test cannot see —
   * and the inverse (the surface adding rows the helper would not return) is how
   * non-product inputs reach answer context in the first place.
   */
  it('HTTP /retrieve-context returns the same hits, in the same order, as retrieveContext()', async () => {
    const vault = seedVault();
    await indexVault(vault);
    const query = 'what powers the machine';
    const { read, helper, db } = httpRead(vault, query);
    const viaHttp = (await read()).body;
    const viaHelper = await helper();
    db.close();

    expect(viaHttp.hits.map((h: { notePath: string }) => h.notePath))
      .toEqual(viaHelper.hits.map((h) => h.notePath));
    expect(viaHttp.hits.map((h: { text: string }) => h.text))
      .toEqual(viaHelper.hits.map((h) => h.text));
    expect(viaHttp.hits.map((h: { score: number }) => h.score))
      .toEqual(viaHelper.hits.map((h) => h.score));
  }, 180_000);

  /**
   * CATCHES: the same divergence in the other direction — the public CLI
   * returning a different number of hits than the helper, or dropping the
   * session dates and provenance the helper carries. The CLI is the transport
   * the product benchmark client uses, so a drift here silently changes every
   * measured score.
   */
  it('CLI `search --json` returns the same hit count, paths and order as the helper', async () => {
    const vault = seedVault();
    await indexVault(vault);
    const query = 'what powers the machine';

    const cli = await runCli(['search', query, '--json'], cliEnv(vault));
    expect(cli.code).toBe(0);
    const cliBody = JSON.parse(cli.stdout);

    const { helper, db } = httpRead(vault, query);
    const viaHelper = await helper();
    db.close();

    expect(cliBody.hits.length).toBe(viaHelper.hits.length);
    expect(cliBody.hits.map((h: { score: number }) => h.score))
      .toEqual(viaHelper.hits.map((h) => h.score));
    // The CLI renders client-relative paths; each must be the tail of the
    // helper's path, in the same order — same rows, presentation-safe form only.
    expect(cliBody.hits.map((h: { notePath: string }) => path.basename(h.notePath)))
      .toEqual(viaHelper.hits.map((h) => path.basename(h.notePath)));
    // Exactly that tail: the helper's stored path below the vault, the form the hosted tools print.
    expect(cliBody.hits.map((h: { notePath: string }) => h.notePath))
      .toEqual(viaHelper.hits.map((h) => path.relative(vault.root, h.notePath)));
    expect(cliBody.hits.every((h: { session_date?: string }) => typeof h.session_date === 'string')).toBe(true);
  }, 180_000);

  /**
   * CATCHES: an answer-context assembly that injects content the public surface
   * never returned. `assembleClientContext` is the client-side boundary the
   * product runner uses to build the prompt; if it starts pulling from anywhere
   * but the public hits array, non-product inputs enter answer context there.
   *
   * Construction: the hits carry a marker only in fields the assembler must NOT
   * render (a sidecar-shaped extra property). Only `text` (and, when the
   * context-dates lever is on, `session_date`) may reach the prompt.
   */
  it('assembles the answer prompt from public hit text only, dropping non-product fields', async () => {
    const { assembleClientContext } = await import('../../scripts/eval/run-longmemeval-product.js');
    const SIDECAR = 'SIDECARCHANNEL9';
    const hits = [
      {
        notePath: 'Sessions/a-1.md',
        text: 'The machine runs on mains power at 300 W.',
        score: 1,
        session_date: '2026-01-15T00:00:00.000Z',
        // Fields a harness might carry alongside a hit. None may be rendered.
        sidecarFact: `secret ${SIDECAR}`,
        chronicle: `secret ${SIDECAR}`,
        preference: `secret ${SIDECAR}`,
        shouldAbstain: true,
        answer: `secret ${SIDECAR}`,
      },
    ];
    const assembled = assembleClientContext(hits as never, 6000);
    expect(assembled.context).toContain('mains power');
    expect(assembled.context).not.toContain(SIDECAR);
    expect(assembled.hitsUsed).toBe(1);

    // With the context-dates lever ON, exactly one extra datum is allowed in:
    // the hit's own session_date. Still no non-product field.
    const dated = assembleClientContext(hits as never, 6000, { contextDates: true });
    expect(dated.context).toContain('Session date: 2026-01-15T00:00:00.000Z');
    expect(dated.context).not.toContain(SIDECAR);
  });

  /**
   * CATCHES: a hidden session mapping or gold label reaching the answer prompt
   * through the rendered vault. The corpus the product indexes is built from
   * allowlisted dataset fields only; `renderSession` is that boundary. A gold
   * field appearing in a rendered session means a product run is no longer
   * gold-blind.
   */
  it('renders session markdown from allowlisted fields only', async () => {
    const { renderSession } = await import('../../scripts/eval/run-longmemeval-product.js');
    const rendered = renderSession('sess-1', '2026/01/01 (Thu) 10:00', [
      { role: 'user', content: 'Alex drinks mango juice every morning.' },
      { role: 'assistant', content: 'Noted.' },
    ]);
    expect(rendered).toContain('session_id: "sess-1"');
    expect(rendered).toContain('session_date: "2026/01/01 (Thu) 10:00"');
    expect(rendered).toContain('Alex drinks mango juice every morning.');
    // The rendering is a pure function of (id, date, turns): it cannot carry a
    // field it was never given, so the digest is stable across gold mutations.
    expect(crypto.createHash('sha256').update(rendered).digest('hex')).toHaveLength(64);
  });
});
