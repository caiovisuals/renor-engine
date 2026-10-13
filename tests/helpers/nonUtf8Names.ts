import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Fixtures for file names that are not valid UTF-8 (a Latin-1 "Reunião.md" that another OS or
 * locale wrote). Node decodes such a name with U+FFFD, so its string form names nothing that
 * exists: create and read these paths as bytes.
 */
export const bytes = (...parts: Array<string | number[]>): Buffer =>
  Buffer.concat(parts.map(part => Buffer.from(part)));

export const latin1 = (text: string): Buffer => Buffer.from(text, 'latin1');

/** `root` followed by each segment, joined with `/`, as bytes. */
export function rawPath(root: string, ...segments: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(root), ...segments.flatMap(segment => [Buffer.from('/'), segment])]);
}

/** Whether this filesystem can store such a name at all (APFS refuses it with EILSEQ). */
export const supportsNonUtf8Names: boolean = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utf8-probe-'));
  try {
    fs.writeFileSync(rawPath(dir, Buffer.from([0xff])), '');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
