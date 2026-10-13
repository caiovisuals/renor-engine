import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Measurement-side helpers shared by the eval runners. Evaluator provenance
 * (source hash, git state) lives in src/eval/runManifest.ts — the single
 * authority — so only artifact-safety utilities live here.
 */

export function sha256(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data as unknown as string).digest('hex');
}

/** Exclusive claim: never overwrite another worker's run, even after failure. */
export function claimDirectory(directory: string): void {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory, { mode: 0o700 });
}

/** Fixtures must consist only of regular files/directories. No external links. */
export function assertRegularTree(root: string): void {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`Non-regular fixture entry: ${root}`);
  }
  if (stat.isDirectory()) for (const child of fs.readdirSync(root)) assertRegularTree(path.join(root, child));
}

export function safeEndpoint(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Embedding base URL must be HTTP(S) without credentials, query, or fragment');
  }
  return value;
}