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
 * So the suite compiles the tree it is about to test, once, before any test file loads. `tsc`
 * rewrites the output of every current source, and before compiling this removes the orphans:
 * `.js`, `.d.ts` and `.map` files in the tsconfig's `outDir` whose source under its `rootDir` no
 * longer exists (`tsc` never prunes, so a deleted or renamed source would otherwise keep a stale
 * output that a test can still load). Nothing else in `dist/` is touched, and the directory is
 * never removed, because parallel gates may share it.
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

export default function setup(): void {
  const engineDir = path.resolve(__dirname, '..');
  const tsconfig = path.join(engineDir, 'tsconfig.json');
  pruneOrphanOutputs(tsconfig);
  const tsc = path.join(engineDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const res = spawnSync(process.execPath, [tsc, '-p', tsconfig], {
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
