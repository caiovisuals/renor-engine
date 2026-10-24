import { vi } from 'vitest';

/** Every console call, method and arguments, until restored (vi.restoreAllMocks). */
export function captureConsole(): Array<{ method: string; args: unknown[] }> {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { calls.push({ method, args }); });
  }
  return calls;
}

/** An error whose message and every stack frame name a synthetic absolute path under `dir`. */
export function errorNaming(dir: string, cause = 'EACCES: permission denied, open'): Error {
  const file = `${dir}/notes/private.md`;
  const err = new Error(`${cause} '${file}'`);
  err.stack = `Error: ${err.message}\n    at readNote (${file}:1:1)\n    at indexFile (${dir}/.memory-index/engine.js:12:3)`;
  return err;
}
