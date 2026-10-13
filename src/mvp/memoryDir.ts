import fs from 'fs';
import path from 'path';

/**
 * The memory directory holds the user's statements in plain text (daily notes, the ledger) and the index built
 * from them, so it is owner-only, as the OAuth client store already is. A directory the running user owns that
 * group or others can reach is tightened at start (0700 for directories, 0600 for files, one log line); one that
 * cannot be tightened, because someone else owns it or the change is refused, stops the start.
 */

function failClosed(dir: string, reason: string): never {
  throw new Error(
    `Memory directory is not usable: ${reason}. `
    + 'Refusing to start with a memory directory other users can read (fail closed). '
    + `Run: chmod -R go-rwx ${JSON.stringify(dir)} as its owner, then start again.`);
}

const accessibleByOthers = (mode: number): boolean => (mode & 0o077) !== 0;

/** Tightens what is owned by `uid` under `dir`, without following symlinks; what someone else owns is left alone. */
function tightenTree(dir: string, uid: number): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    const stat = fs.lstatSync(full);
    if (stat.uid !== uid) continue;
    if (entry.isDirectory()) {
      if (accessibleByOthers(stat.mode)) fs.chmodSync(full, 0o700);
      tightenTree(full, uid);
    } else if (entry.isFile() && accessibleByOthers(stat.mode)) {
      fs.chmodSync(full, 0o600);
    }
  }
}

/**
 * Creates the directory owner-only (0700) when it does not exist. One that exists must be a directory owned by the
 * running user; if group or others can access it, it is tightened (everything under it that the user owns too) and
 * `log` is told once. Symlinked paths are followed (the directory may live on another disk).
 */
export function ensureOwnerOnlyMemoryDir(dir: string, log: (line: string) => void = console.log): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // A file at the path is reported below as what it is.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const uid = process.getuid?.();
  // No POSIX owner to compare on this platform; the client store refuses to run there as well.
  if (uid === undefined) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    failClosed(dir, `it is unreadable (${(err as NodeJS.ErrnoException).code})`);
  }
  if (!stat.isDirectory()) failClosed(dir, 'the path is not a directory');
  if (stat.uid !== uid) failClosed(dir, 'it is not owned by the service user, so it cannot be tightened to owner-only (0700)');
  if (!accessibleByOthers(stat.mode)) return;
  const was = (stat.mode & 0o777).toString(8);
  try {
    fs.chmodSync(dir, 0o700);
    tightenTree(dir, uid);
  } catch (err) {
    failClosed(dir, `it is accessible by group or others (mode ${was}) and cannot be tightened to owner-only (0700) (${(err as NodeJS.ErrnoException).code})`);
  }
  log(`[mvp] memory directory ${dir} was accessible by group or others (mode ${was}); tightened to owner-only: directories 0700, files 0600`);
}

/** A database file that exists and group or others can reach is tightened to 0600, with its -wal and -shm files. */
export function ensureOwnerOnlyFile(file: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (stat.isFile() && stat.uid === uid && accessibleByOthers(stat.mode)) fs.chmodSync(candidate, 0o600);
  }
}
