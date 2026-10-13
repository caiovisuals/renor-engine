import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../vitest.config';

const engineDir = path.resolve(__dirname, '..');

describe('globalSetup wiring', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('vitest.config.ts registers a globalSetup file that exists', () => {
    const entries = [config.test?.globalSetup ?? []].flat();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(fs.existsSync(path.resolve(engineDir, entry))).toBe(true);
    expect(entries.map((e) => path.basename(e))).toContain('globalSetup.ts');
  });

  async function loadWith(status: number) {
    const spawnSync = vi.fn(() => ({ status, stdout: 'out', stderr: 'diagnostic', error: undefined }));
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawnSync, default: { spawnSync } }));
    const mod = await import('./globalSetup.js');
    return { setup: mod.default as unknown as () => void, spawnSync };
  }

  it('compiles with tsc -p tsconfig.json and passes on exit 0', async () => {
    const { setup, spawnSync } = await loadWith(0);
    expect(() => setup()).not.toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnSync.mock.calls[0] as unknown as [string, string[], { timeout: number; maxBuffer: number }];
    expect(args[0]).toMatch(/typescript[\\/]bin[\\/]tsc$/);
    expect(args.slice(1)).toEqual(['-p', path.join(engineDir, 'tsconfig.json')]);
    expect(opts.timeout).toBeGreaterThanOrEqual(120_000);
    expect(opts.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it('throws, with the compiler output, on a non-zero exit', async () => {
    const { setup } = await loadWith(2);
    expect(() => setup()).toThrow(/exit 2[\s\S]*diagnostic/);
  });
});

describe('pruneOrphanOutputs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('removes outputs whose source is gone and keeps current ones', async () => {
    const { pruneOrphanOutputs } = await import('./globalSetup.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    dirs.push(root);
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' }, include: ['src/**/*'] }),
    );
    fs.mkdirSync(path.join(root, 'src/sub'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist/sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/live.ts'), '');
    fs.writeFileSync(path.join(root, 'src/sub/deep.ts'), '');
    const keep: string[] = ['live.js', 'live.d.ts', 'live.js.map', 'live.d.ts.map', 'sub/deep.js', 'data.json'];
    const drop: string[] = ['gone.js', 'gone.d.ts', 'gone.js.map', 'gone.d.ts.map', 'sub/old.js'];
    for (const f of [...keep, ...drop]) fs.writeFileSync(path.join(root, 'dist', f), '');
    // outside outDir: never touched
    fs.writeFileSync(path.join(root, 'stray.js'), '');

    const removed = pruneOrphanOutputs(path.join(root, 'tsconfig.json'));

    expect(removed.map((f: string) => path.relative(path.join(root, 'dist'), f)).sort()).toEqual([...drop].sort());
    for (const f of keep) expect(fs.existsSync(path.join(root, 'dist', f))).toBe(true);
    for (const f of drop) expect(fs.existsSync(path.join(root, 'dist', f))).toBe(false);
    expect(fs.existsSync(path.join(root, 'stray.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(true);
  });

  it('is a no-op when outDir does not exist', async () => {
    const { pruneOrphanOutputs } = await import('./globalSetup.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }));
    expect(pruneOrphanOutputs(path.join(root, 'tsconfig.json'))).toEqual([]);
  });
});
