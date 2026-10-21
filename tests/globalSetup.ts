import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Some tests start the COMPILED engine (`dist/mvp/cli.js`) or require a compiled module from a
 * `node -e` child, because that is what a workspace's unit runs. `dist/` is build output, so a
 * fresh checkout has none, and a suite that passed only because an earlier build had left one
 * behind is not a verdict on the tree (#357 merged green that way and failed on a fresh clone).
 *
 * So the suite compiles the tree it is about to test, once, before any test file loads.
 *
 * The compile is `tsc -b tsconfig.json`, the incremental build driver: `tsconfig.json` carries
 * `incremental: true`, so the second and later invocations of the same tree (a re-gate, a
 * single-file iteration, the gate's own `npm run build` right after this one) are a buildinfo
 * check — fractions of a CPU-second when nothing changed — instead of a full `tsc` (~20 CPU-s).
 * The buildinfo is written only by a successful build, and tsc re-checks a project whose last
 * build had errors, so a tree that does not compile still fails here first (#357: the suite must
 * never run against a `dist/` that no current compile produced).
 *
 * Before compiling, this removes the orphans: `.js`, `.d.ts` and `.map` files in the tsconfig's
 * `outDir` whose source under its `rootDir` no longer exists (`tsc` never prunes, so a deleted or
 * renamed source would otherwise keep a stale output that a test can still load). Nothing else in
 * `dist/` is touched, and the directory is never removed, because parallel gates may share it.
 */

const OUTPUT_SUFFIXES = ['.d.ts.map', '.js.map', '.d.ts', '.js'];
const SOURCE_SUFFIXES = ['.ts', '.tsx'];

/** Delete the orphaned outputs of the tsconfig's `outDir`; returns them (sorted, absolute). */
export function pruneOrphanOutputs(tsconfigPath: string): string[] {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) throw new Error(`cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  const options = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath)).options;
  if (!options.outDir || !options.rootDir) throw new Error(`${tsconfigPath} must name outDir and rootDir`);
  const outDir = path.resolve(options.outDir);
  const rootDir = path.resolve(options.rootDir);
  if (!fs.existsSync(outDir)) return [];

  const orphans: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const suffix = OUTPUT_SUFFIXES.find((s) => entry.name.endsWith(s));
      if (!suffix) continue;
      const base = path.join(rootDir, path.relative(outDir, full).slice(0, -suffix.length));
      if (!SOURCE_SUFFIXES.some((s) => fs.existsSync(base + s))) orphans.push(full);
    }
  };
  walk(outDir);
  orphans.sort();
  for (const file of orphans) fs.rmSync(file, { force: true });
  return orphans;
}

/**
 * The outputs `tsc -b` would consider current but which are not on disk.
 *
 * Build mode decides from the buildinfo alone: `rm -rf dist` leaves it intact, so the project
 * reads "up to date" and nothing is emitted — the suite would then load a `dist/` that does not
 * exist. #357 is why that must not pass: the suite compiles the tree it tests, and "compiled"
 * means the outputs are present. This lists every source's expected output that is missing from
 * `outDir`; a non-empty list turns the compile into `tsc -b --force`.
 *
 * The mapping is tsc's own emit table, one output per input: `.ts`/`.tsx`/`.js`/`.jsx` -> `.js`,
 * `.mts`/`.mjs` -> `.mjs`, `.cts`/`.cjs` -> `.cjs`, any other included file (a `.json`) -> the
 * same relative path, and a **declaration input** (`.d.ts`, `.d.cts`, `.d.mts`) -> nothing at
 * all. Declarations must be skipped or the list says "missing" forever for a file that is never
 * emitted: `src/memory/hiveNameHeader.d.cts` (#532) did exactly that, which a gate caught as a
 * `--force` on every run.
 *
 * Fails in the slow direction only: a file this cannot map is treated as missing, which costs one
 * full rebuild, never a skipped one.
 */
const DECLARATION_INPUT = /\.d\.(ts|cts|mts)$/;
const EMIT_EXTENSION: Record<string, string> = {
  '.ts': '.js', '.tsx': '.js', '.js': '.js', '.jsx': '.js',
  '.mts': '.mjs', '.mjs': '.mjs', '.cts': '.cjs', '.cjs': '.cjs',
};

export function missingOutputs(tsconfigPath: string): string[] {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) throw new Error(`cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath));
  const { outDir, rootDir } = parsed.options;
  if (!outDir || !rootDir) throw new Error(`${tsconfigPath} must name outDir and rootDir`);
  const out = path.resolve(outDir);
  const root = path.resolve(rootDir);
  const missing: string[] = [];
  for (const file of parsed.fileNames) {
    if (DECLARATION_INPUT.test(file)) continue; // type-only inputs emit nothing
    const relative = path.relative(root, file);
    if (relative.startsWith('..')) continue; // outside rootDir: tsc would not emit it either
    const extension = path.extname(relative);
    const emitted = EMIT_EXTENSION[extension]
      ? path.join(out, relative.slice(0, -extension.length) + EMIT_EXTENSION[extension])
      : path.join(out, relative);
    if (!fs.existsSync(emitted)) missing.push(emitted);
  }
  return missing.sort();
}

export default function setup(): void {
  const engineDir = path.resolve(__dirname, '..');
  const tsconfig = path.join(engineDir, 'tsconfig.json');
  pruneOrphanOutputs(tsconfig);
  const tsc = path.join(engineDir, 'node_modules', 'typescript', 'bin', 'tsc');
  // Build mode is trustworthy about sources but not about outputs: force a full rebuild the moment
  // an expected output is missing (the buildinfo cannot know `dist/` was removed by hand).
  const missing = missingOutputs(tsconfig);
  const force = missing.length > 0;
  // `-b` (build mode): trust the buildinfo only when it matches this tree; a missing or stale one
  // is a full compile, and one whose last build failed is compiled again. `-p` would always
  // re-check every file even when the buildinfo is current.
  const res = spawnSync(process.execPath, [tsc, '-b', ...(force ? ['--force'] : []), tsconfig], {
    cwd: engineDir,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const why = res.error ? ` (${res.error.message})` : '';
    throw new Error(`engine build (tsc) failed before the suite, exit ${res.status}${why}:\n${res.stdout}${res.stderr}`);
  }
  // `npm run build` copies the CommonJS name reducer that tsc does not emit; the suite must see the same dist.
  const reducer = 'hiveNameHeader.cjs';
  fs.copyFileSync(path.join(engineDir, 'src', 'memory', reducer), path.join(engineDir, 'dist', 'memory', reducer));
}
