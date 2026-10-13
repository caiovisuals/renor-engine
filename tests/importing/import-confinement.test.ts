// Adversary run renor-adv-vaultfs-1012: the apply layer (the one `renor import` calls) wrote below a symbolic link in the
// destination vault, out of it, and rewrote the ledger through one. The hosted tools refuse an unsafe destination before
// they get here; the apply layer is the last line, and holds the same rule itself.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { readSource } from '../../src/importing/source';
import { buildImportPlan } from '../../src/importing/plan';
import { applyImportPlan } from '../../src/importing/apply';
import { BUNDLE_FORMAT } from '../../src/importing/types';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'import-confine-')));
  roots.push(root);
  const memoryDir = path.join(root, 'vault');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(memoryDir);
  fs.mkdirSync(outside);
  const dbPath = path.join(memoryDir, '.memory-index', 'index.db');
  const db = openDb(dbPath);
  runMigrations(db);
  db.close();
  const file = path.join(root, 'bundle.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'meta', format: BUNDLE_FORMAT, source: 's' }),
    JSON.stringify({
      type: 'note', path: '/s/a.md', relPath: 'a.md', title: 'a', modifiedAt: '2026-01-02T03:04:05.000Z',
      chunks: [{ headingPath: 'a', text: '# a\n\nbody', tokenCount: 3 }], entities: [],
    }),
    JSON.stringify({
      type: 'fact', subject: 'Renor', predicate: 'color', object: 'black', scope: 'global',
      validFrom: '2026-01-02T00:00:00.000Z', sourcePath: '_mcp_', origin: 'ledger',
    }),
  ].join('\n') + '\n');
  const bundle = readSource(`bundle:${file}`, { include: [], exclude: [] });
  const plan = buildImportPlan(bundle, { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' });
  return { memoryDir, outside, dbPath, bundle, plan };
}

describe('applyImportPlan inside a vault that holds links', () => {
  it('does not write below a symlinked destination directory', async () => {
    const t = setup();
    fs.symlinkSync(t.outside, path.join(t.memoryDir, 'Imported'));
    await expect(applyImportPlan(t.plan, t.bundle, { memoryDir: t.memoryDir, dbPath: t.dbPath })).rejects.toThrow(/refusing to write below "Imported"/);
    expect(fs.readdirSync(t.outside)).toEqual([]);
  });

  it('does not append the ledger through a symlinked ledger file, and leaves what it points at alone', async () => {
    const t = setup();
    fs.writeFileSync(path.join(t.outside, 'ledger.md'), 'OUTSIDE-CANARY\n');
    fs.mkdirSync(path.join(t.memoryDir, 'System'));
    fs.symlinkSync(path.join(t.outside, 'ledger.md'), path.join(t.memoryDir, 'System/Memory Events Ledger.md'));
    await expect(applyImportPlan(t.plan, t.bundle, { memoryDir: t.memoryDir, dbPath: t.dbPath })).rejects.toThrow(/refusing to write/);
    expect(fs.readFileSync(path.join(t.outside, 'ledger.md'), 'utf8')).toBe('OUTSIDE-CANARY\n');
    expect(fs.readdirSync(t.outside)).toEqual(['ledger.md']);
  });

  it('still imports into an ordinary vault', async () => {
    const t = setup();
    const result = await applyImportPlan(t.plan, t.bundle, { memoryDir: t.memoryDir, dbPath: t.dbPath });
    expect(result.notesWritten).toBe(1);
    expect(fs.existsSync(path.join(t.memoryDir, 'Imported/src/a.md'))).toBe(true);
  });
});
