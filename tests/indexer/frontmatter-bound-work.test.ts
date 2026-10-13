import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import ts from 'typescript';
import { assertFrontmatterBounded } from '../../src/indexer/parser';

// Refusing an alias bomb has to be cheap, not just eventual. A wall-clock assertion flakes on a loaded shared host,
// so these measure the work itself: how much of the structure the check touches, and the peak memory of a fresh
// process. Neither depends on how busy the machine is.

const bound = (sourceLength: number) => 64 * 1024 + 4 * sourceLength;

/** Counts every read of the wrapped array: how much of a structure the bound check touched. */
function counted<T extends object>(target: T, tally: { reads: number }): T {
  return new Proxy(target, { get(t, key, receiver) { tally.reads++; return Reflect.get(t, key, receiver); } });
}

describe('the frontmatter bound stops early', () => {
  it('touches a few dozen elements of a flat list that would serialize to 300 MB', () => {
    const tally = { reads: 0 };
    const big = 'x'.repeat(30_000);
    // 10,000 references to one 30,000-character scalar: what a 60 KB note of YAML aliases parses to.
    const frontmatter = { big, list: counted(Array(10_000).fill(big), tally) };
    expect(() => assertFrontmatterBounded(frontmatter, 60_026)).toThrow(/too large/);
    expect(tally.reads).toBeLessThan(100); // walking the list instead is more than 10,000 reads
  });

  it('is bounded by the bound, not by the expansion, inside a nested alias bomb', () => {
    const tally = { reads: 0 };
    let level: unknown[] = counted(Array(8).fill('x'), tally);
    for (let depth = 0; depth < 6; depth++) level = counted(Array(8).fill(level), tally); // 8^7 leaves, about two million
    expect(() => assertFrontmatterBounded({ bomb: level }, 400)).toThrow(/too large/);
    expect(tally.reads).toBeLessThan(4 * bound(400)); // every read costs at least a byte of the bound
  });
});

describe('refusing a flat alias note in a fresh process', () => {
  const engineDir = path.join(__dirname, '../..');
  // 10,000 references to one 30,000-character scalar: a 60 KB note that would serialize to 300 MB.
  const note = `---\nb: &b ${'x'.repeat(30_000)}\nl: [${Array(10_000).fill('*b').join(',')}]\n---\n# Flat`;
  // parser.ts and the engine modules it imports, transpiled here so the child is a plain `node` with no loader.
  const modules: Record<string, string> = {};
  const transpile = (file: string): void => {
    if (file in modules) return;
    modules[file] = ts.transpileModule(fs.readFileSync(path.join(engineDir, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    for (const [, spec] of modules[file].matchAll(/require\("(\.[^"]+)"\)/g)) {
      transpile(path.posix.join(path.posix.dirname(file), `${spec}.ts`));
    }
  };
  transpile('src/indexer/parser.ts');

  /** Runs `body` against the note in a new process, so its peak RSS belongs to that one call. The timeout is only a hang backstop. */
  function inFreshProcess(body: string): { refused?: boolean; message?: string; bytes?: number; maxRssMb: number } {
    const script = [
      `const modules = ${JSON.stringify(modules)};`,
      'const loaded = {};',
      'const load = (file) => {',
      '  if (!loaded[file]) {',
      '    const module = { exports: {} };',
      '    loaded[file] = module;',
      "    const { posix } = require('path');",
      "    const local = (spec) => (spec.startsWith('.') ? load(posix.join(posix.dirname(file), `${spec}.ts`)) : require(spec));",
      "    new Function('exports', 'require', 'module', modules[file])(module.exports, local, module);",
      '  }',
      '  return loaded[file].exports;',
      '};',
      "const parser = load('src/indexer/parser.ts');",
      "const note = require('fs').readFileSync(0, 'utf8');",
      'let result;',
      body,
      'console.log(JSON.stringify({ ...result, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));',
    ].join('\n');
    const run = spawnSync(process.execPath, ['-e', script], { cwd: engineDir, input: note, encoding: 'utf8', timeout: 90_000 });
    if (run.status !== 0) throw new Error(`child failed: status ${run.status}, signal ${run.signal}, ${run.error?.message ?? ''} ${run.stderr.slice(0, 300)}`);
    return JSON.parse(run.stdout.trim().split('\n').pop()!);
  }

  it('peaks far below what serializing the expansion costs', () => {
    expect(Buffer.byteLength(note)).toBeLessThan(64 * 1024);
    const refusal = inFreshProcess("try { parser.parseNote('/v/flat.md', note); result = { refused: false }; } catch (error) { result = { refused: true, message: String(error.message) }; }");
    // The obvious alternative, serialize and then measure, is the control: it shows peak RSS exposes the expansion.
    // A V8 heap cap would not (large strings are allowed past --max-old-space-size), which is why this measures RSS.
    const naive = inFreshProcess("const data = require('gray-matter')(note, {}).data; result = { bytes: Buffer.byteLength(JSON.stringify(data)) };");
    expect(refusal.refused).toBe(true);
    expect(refusal.message).toMatch(/too large/);
    expect(naive.bytes).toBeGreaterThan(250_000_000);
    expect(naive.maxRssMb - refusal.maxRssMb, 'MB of RSS the expansion costs').toBeGreaterThan(200);
    expect(refusal.maxRssMb, 'peak RSS of refusing, in MB').toBeLessThan(150);
  }, 120_000);
});
