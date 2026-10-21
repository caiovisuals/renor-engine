/**
 * Phase-0 wiring check (zero model calls): do the C2/C3/C4/C5 write-path flags
 * surface fact-derived content in the assembled ANSWER CONTEXT of the product
 * benchmark runner? Reproduces the runner's chain:
 *   rendered vault -> public `cli index` -> public `cli search --json`
 *   -> assembleClientContext (the exact runner function)
 * Structured rows are injected at the DB layer via the shipped rowStore API
 * (exactly what the write path would store), so no extractor model calls occur.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/client';
import { insertStructuredRows, type NewStructuredRow } from '../../src/context/rowStore';

/**
 * Portable repo root without the ESM import-meta URL API (package.json has "type":"commonjs";
 * tsconfig.eval / Node16 rejects that API in CJS output). Walk from cwd.
 */
function resolveRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        // renor-engine since PR 761; renor before it.
        if (pkg.name === 'renor-engine' || pkg.name === 'renor') return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`diagnose-facts-surfacing: could not find renor package.json from cwd=${process.cwd()}`);
}

const REPO = resolveRepoRoot();

interface PublicHit { notePath: string; text: string; score: number }

const NOTE_FACTS = `---
kind: longmemeval-session
session_id: sess-facts-001
session_date: "2025-03-10 14:00:00"
---
# Session sess-facts-001

Timestamp: 2025-03-10 14:00:00

### Turn 1 — User

I finally ran the Berlin Marathon. My official finish time was 3 hours 42 minutes and I ran a total of 42.2 kilometers.

### Turn 2 — Assistant

Congratulations! A 3:42 marathon over 42.2 km is a strong result.
`;

const NOTE_NOISE = `---
kind: longmemeval-session
session_id: sess-noise-001
session_date: "2025-03-11 09:00:00"
---
# Session sess-noise-001

Timestamp: 2025-03-11 09:00:00

### Turn 1 — User

We discussed the team offsite logistics and the new office plant budget.
`;

const QUERY = 'Question date: 2025-06-01\nWhat was my Berlin Marathon finish time and distance?';

const COMBOS: Array<{ id: string; env: Record<string, string> }> = [
  { id: 'a-baseline-all-off', env: {} },
  { id: 'b-typed-facts', env: { RENOR_TYPED_FACTS: '1' } },
  { id: 'c-typed+qscoped', env: { RENOR_TYPED_FACTS: '1', RENOR_QUERY_SCOPED_ROWS: '1' } },
  { id: 'd-full-writepath', env: { RENOR_TYPED_FACTS: '1', RENOR_CHRONICLE: '1', RENOR_PREFS: '1', RENOR_QUERY_SCOPED_ROWS: '1' } },
  { id: 'e-plus-structured-ctx', env: { RENOR_TYPED_FACTS: '1', RENOR_CHRONICLE: '1', RENOR_PREFS: '1', RENOR_QUERY_SCOPED_ROWS: '1', RENOR_STRUCTURED_CONTEXT: '1' } },
];

function runCli(args: string[], env: Record<string, string>, dbPath: string, vaultDir: string) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      VAULT_PATH: vaultDir,
      DB_PATH: dbPath,
      EMBEDDING_PROVIDER: 'eval-hash',
      LLM_EXTRACTION: 'false',
      INDEX_CONCURRENCY: '2',
      // Force evidence OFF in the CLI subprocess. Ambient OLLAMA_*/OPENAI_* keys
      // in a developer shell must not trigger live evidence extraction — this
      // probe is zero model calls by construction (same kill-switch as
      // diagnose-evalcache-path-variance.ts).
      RENOR_SEARCH_EVIDENCE: '0',
      ...env,
    },
    encoding: 'utf8',
  });
  if (child.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${child.stderr?.slice(-500)}`);
  return child.stdout;
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'phase0-facts-'));
  const vaultDir = path.join(root, 'vault');
  await fsp.mkdir(path.join(vaultDir, 'Sessions'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'Sessions', 'sess-facts-001.md'), NOTE_FACTS, 'utf8');
  await fsp.writeFile(path.join(vaultDir, 'Sessions', 'sess-noise-001.md'), NOTE_NOISE, 'utf8');

  // 1) Baseline index through the public CLI (all flags off).
  const baseDb = path.join(root, 'base.db');
  const indexOut = runCli(['index'], {}, baseDb, vaultDir);
  console.log('INDEX:', indexOut.trim().split('\n').pop());

  // 2) Inject structured rows exactly as the write path would (shipped rowStore).
  const db = openDb(baseDb);
  const noteRow = db.prepare(`SELECT path, note_hash FROM notes WHERE path LIKE '%sess-facts-001%'`).get() as
    { path: string; note_hash: string } | undefined;
  if (!noteRow) throw new Error('facts note not found in notes table');
  const chunk = db.prepare(`SELECT id FROM chunks WHERE note_path = ? ORDER BY id LIMIT 1`).get(noteRow.path) as
    { id: number } | undefined;
  if (!chunk) throw new Error('no chunk for facts note');
  const rows: NewStructuredRow[] = [
    {
      rowKind: 'fact',
      sourcePath: noteRow.path,
      sourceChunkId: chunk.id,
      sourceHash: noteRow.note_hash,
      extractionVersion: 'typed-facts-v1-probe',
      validFrom: '2025-03-10 14:00:00',
      payload: { value: '3:42', verb: 'ran', object: 'Berlin Marathon finish time', event: 'Berlin Marathon' },
    },
    {
      rowKind: 'fact',
      sourcePath: noteRow.path,
      sourceChunkId: chunk.id,
      sourceHash: noteRow.note_hash,
      extractionVersion: 'typed-facts-v1-probe',
      validFrom: '2025-03-10 14:00:00',
      payload: { value: '42.2', unit: 'km', verb: 'ran', object: 'Berlin Marathon distance', event: 'Berlin Marathon' },
    },
    {
      rowKind: 'event',
      sourcePath: noteRow.path,
      sourceChunkId: chunk.id,
      sourceHash: noteRow.note_hash,
      extractionVersion: 'chronicle-v1-probe',
      validFrom: '2025-03-10 14:00:00',
      payload: { when: '2025-03-10', event: 'ran Berlin Marathon', entities: ['Berlin Marathon'] },
    },
    {
      rowKind: 'preference',
      sourcePath: noteRow.path,
      sourceChunkId: chunk.id,
      sourceHash: noteRow.note_hash,
      extractionVersion: 'prefs-v1-probe',
      validFrom: null,
      payload: { statement: 'prefers marathon results reported with official finish time', kind: 'reporting' },
    },
  ];
  insertStructuredRows(db, rows);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM structured_rows WHERE valid_to IS NULL`).get() as { c: number };
  console.log('ROWS-STORED(current):', count.c);
  db.close();

  // 3) Public `cli search --json` under each combo, byte-diff.
  const outputs = new Map<string, string>();
  for (const combo of COMBOS) {
    const comboDb = path.join(root, `combo-${combo.id}.db`);
    await fsp.copyFile(baseDb, comboDb);
    const stdout = runCli(['search', '--json', '--top-k', '20', QUERY], combo.env, comboDb, vaultDir);
    outputs.set(combo.id, stdout);
  }

  const baseline = outputs.get('a-baseline-all-off')!;
  const baselineHits = JSON.parse(baseline).hits;
  console.log('BASELINE-HITS:', baselineHits.length);

  for (const combo of COMBOS) {
    const stdout = outputs.get(combo.id)!;
    const parsed = JSON.parse(stdout) as { hits: PublicHit[]; composedContext?: unknown };
    // Score floats wobble in the last ULP across processes; compare hit content.
    const hitsContent = JSON.stringify(parsed.hits.map((h: PublicHit) => ({ notePath: h.notePath, text: h.text })));
    const baselineContent = JSON.stringify((baselineHits as PublicHit[]).map((h: PublicHit) => ({ notePath: h.notePath, text: h.text })));
    const hitsByteDiff = hitsContent !== baselineContent;
    const composed = parsed.composedContext as { text?: string; includedSections?: string[]; usedTokens?: number } | undefined;
    const factInComposed = composed?.text?.includes('3:42') === true || composed?.text?.includes('42.2') === true;
    const factInHits = JSON.stringify(parsed.hits).includes('3:42') || JSON.stringify(parsed.hits).includes('42.2');
    console.log(`COMBO ${combo.id}: hitsByteDiffFromBaseline=${hitsByteDiff} ` +
      `composedContext=${composed ? `present(sections=${composed.includedSections?.join(',')}, usedTokens=${composed.usedTokens})` : 'ABSENT'} ` +
      `factInComposed=${factInComposed} factInHits=${factInHits}`);
    if (composed) {
      await fsp.writeFile(path.join(root, `composed-${combo.id}.txt`), composed.text ?? '', 'utf8');
    }
  }
  console.log('ROOT:', root);
}

main().catch((err) => { console.error('PROBE-FAILED:', err); process.exit(1); });