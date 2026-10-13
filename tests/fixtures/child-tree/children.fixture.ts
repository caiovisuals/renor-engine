import fs from 'fs';
import { it } from 'vitest';
import { killTree, spawnTree } from '../../helpers/childTree';

/**
 * What the nested run started by tests/helpers/childTree.test.ts executes. FIXTURE_MODE:
 *   clean  start a tsx-shaped child (a supervisor and a grandchild) and tear it down
 *   leak   start it and never tear it down
 *   hold   start it, then stay mid-run until the outer test signals the run
 * FIXTURE_INFO is a file the pgid and grandchild pid are written to once the child is up.
 */
const SUPERVISOR = `
  const { spawn } = require('child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  console.log(grandchild.pid);
  setTimeout(() => {}, 600000);
`;

it('starts a child the way a suite does', async () => {
  const mode = process.env.FIXTURE_MODE ?? 'clean';
  const child = spawnTree(process.execPath, ['-e', SUPERVISOR], { stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = await new Promise<number>((resolve) => child.stdout!.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
  const info = process.env.FIXTURE_INFO;
  if (info) fs.writeFileSync(info, JSON.stringify({ pgid: child.pid, grandchild }));
  if (mode === 'clean') killTree(child);
  if (mode === 'hold') await new Promise((resolve) => setTimeout(resolve, 120_000));
  if (mode === 'hold-then-leak') await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_HOLD_MS ?? 5_000)));
}, 150_000);
