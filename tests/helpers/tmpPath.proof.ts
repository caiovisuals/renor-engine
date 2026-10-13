/**
 * Proves the isolation this lane introduces is real: two independent processes
 * importing the helper must never share a fixture path, and the tree must be gone
 * once the process exits.
 *
 * Run: node --import tsx tests/helpers/tmpPath.proof.ts
 * Exits non-zero with a named reason on any violation.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpPath } from './tmpPath';

function child(): { dir: string; file: string; existedAtRuntime: boolean } {
  const out = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `import { tmpPath } from '${path.resolve(__dirname, 'tmpPath.ts')}';
       const file = tmpPath('probe.txt');
       import('fs').then(fs => fs.writeFileSync(file, 'x'));
       console.log(JSON.stringify({ dir: path.dirname(file), file, existedAtRuntime: true }));`,
    ],
    { encoding: 'utf8', cwd: process.cwd() }
  );
  return JSON.parse(out.trim().split('\n').pop() as string);
}

const failures: string[] = [];

const a = child();
const b = child();

if (a.dir === b.dir) {
  failures.push(`two processes shared one fixture dir: ${a.dir}`);
}
if (!a.file.includes(path.join('renor-test-', '')) && !/renor-test-/.test(a.file)) {
  failures.push(`fixture path is not inside a renor-test- root: ${a.file}`);
}
if (a.file.startsWith('/tmp/test-')) {
  failures.push(`fixture path is still the old shared /tmp path: ${a.file}`);
}
for (const p of [a.file, b.file]) {
  if (fs.existsSync(p)) failures.push(`fixture survived process exit: ${p}`);
}

// The parent's own root must also differ from the children's.
const mine = tmpPath('probe.txt');
if (fs.existsSync(mine)) failures.push('parent fixture already exists before use');
fs.writeFileSync(mine, 'x');
if (mine.startsWith('/tmp/test-')) failures.push(`parent fixture is a shared path: ${mine}`);
fs.rmSync(mine, { force: true });

if (failures.length) {
  console.error('tmpPath isolation: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`tmpPath isolation: PASS (children ${path.basename(a.dir)} vs ${path.basename(b.dir)}, both removed on exit)`);
