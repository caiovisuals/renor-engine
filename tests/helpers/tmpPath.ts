import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Per-process temporary directory for test fixtures.
 *
 * Tests used hardcoded `/tmp/<name>` paths, which makes the filesystem a shared
 * resource: two vitest workers executing the same file (or the test and any other
 * process touching the same path) race on one file, and that surfaces as a flake
 * rather than as a failure — the gate then fails a healthy diff.
 *
 * `os.tmpdir()` already honours `TMPDIR`, so under the gate this is per-run as well
 * as per-process, and the whole tree is removed when the worker exits.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-test-'));

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort: the OS reclaims TMPDIR anyway.
  }
});

/**
 * A path inside this process's temp directory. Not pre-created — callers decide
 * whether they need a file or a directory.
 */
export function tmpPath(name: string): string {
  return path.join(root, name);
}
