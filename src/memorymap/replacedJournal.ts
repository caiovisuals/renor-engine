import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

/** The replacement journal (a correction that names the memory it corrects), beside the retirement journal. */
export const REPLACED_FILE_NAME = 'replaced.jsonl';

/**
 * Drop every replacement record that names one of `memoryIds` as the memory it corrects or the correction that replaces it,
 * so a permanently deleted memory leaves no id behind (export keeps these records). `retiredDir` is the retirement folder,
 * already inside the vault. The file is replaced atomically; a torn or unreadable line is kept as it is, and a file that is
 * not a plain single-name file is refused. Idempotent, so a retry after a crash repeats it harmlessly.
 */
export async function forgetReplacementsOf(retiredDir: string, memoryIds: ReadonlySet<string>): Promise<void> {
  if (memoryIds.size === 0) return;
  const file = path.join(retiredDir, REPLACED_FILE_NAME);
  let st;
  try {
    st = await fs.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!st.isFile() || st.nlink !== 1) throw new Error(`refusing to rewrite ${JSON.stringify(REPLACED_FILE_NAME)}: it is not a regular file with a single name`);
  const raw = await fs.readFile(file, 'utf8');
  let changed = false;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let hit = false;
    try {
      const r = JSON.parse(line) as { old?: unknown; by?: unknown };
      hit = memoryIds.has(String(r.old)) || memoryIds.has(String(r.by));
    } catch {
      // A torn final line is kept as it is; the reader skips it.
    }
    if (hit) changed = true;
    else kept.push(line);
  }
  if (!changed) return;
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, kept.map((line) => `${line}\n`).join(''), { flag: 'wx', mode: st.mode & 0o777 });
  await fs.rename(tmp, file);
}
