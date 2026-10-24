import type Database from '../db/sqlite';
import { assertStorable } from '../extraction/secretGuard';
import { refusal } from '../toolRefusal';
import { assertNoUnstorableControls } from './controls';
import { ensureHandoffTable } from '../db/handoffTable';

/**
 * The handoff note: the one exception to "save no status".
 *
 * One note per repository and branch, overwritten (never appended) at the end of a session and shown at the start of the
 * next session in that same repository and branch. It is status, and status goes stale: 17 of the 33 wrong reads up to
 * 13 Oct 2026 were stale status facts. So the note never enters memory. It lives in its own table (`handoff_notes`,
 * db/handoffTable.ts) that no indexer, search, read, map, what's-new or export path reads; only `readHandoffNote` does.
 * It is dated, carries the agent that wrote it, and is deleted 7 days after it was written.
 *
 * Behind RENOR_HANDOFF_NOTE, default OFF: with it off no tool that writes or reads a note is published, no sweep runs,
 * and the table is never created, so the database is byte for byte what it is without this code.
 *
 * What expiry removes: the row, by a sweep that runs when the server starts and every 15 minutes (not only on a handoff
 * read or write), with SQLite's secure_delete on for that statement, then a WAL checkpoint, so the note's text is
 * overwritten in the database file and gone from its -wal. An overwrite of a note is done the same way. A reader that
 * holds the WAL can stop the checkpoint: the row is gone, and every later sweep retries the checkpoint until it succeeds.
 * The 7 days are counted on a clock that never goes back (storeNow). Neither reaches copies made outside this database:
 * a backup, a filesystem snapshot, or a copy of the file someone took. docs/ENVIRONMENT-VARIABLES.md says the same.
 */

/** A note this old is never shown again, and the sweep deletes it. */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the server sweeps expired notes away, besides at start. */
export const HANDOFF_SWEEP_MS = 15 * 60 * 1000;
/**
 * A note dated further ahead than this was written by a clock that has since gone back (or will go forward): it is
 * treated as expired, so a clock rollback can never keep a note past its 7 days.
 */
export const HANDOFF_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The note is short on purpose: what was in progress, the next step, open questions. */
export const HANDOFF_MAX_WORDS = 200;
export const HANDOFF_MAX_CHARS = 2000;
const MAX_KEY_CHARS = 600;

/** RENOR_HANDOFF_NOTE: on only for 1, true, yes or on (any case). Unset or any other value keeps the note off. */
export function handoffNoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env.RENOR_HANDOFF_NOTE ?? '').trim().toLowerCase());
}

export interface HandoffNote {
  /** The repository key, e.g. `remote:github.com/acme/fjord` (see normaliseRepoKey). */
  repo: string;
  branch: string;
  note: string;
  /** The agent that wrote it: the connection's authenticated name, never a tool argument. */
  writer: string;
  /** ISO instant it was written. */
  written_at: string;
  /** ISO instant after which it is gone. */
  expires_at: string;
}

/**
 * Hosts whose repository paths are case-insensitive and where `x` and `x.git` name the same repository. Only on these
 * are case and a `.git` suffix folded; anywhere else two spellings stay two keys.
 */
const FOLDING_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);
const DEFAULT_PORTS: Record<string, string> = { ssh: '22', https: '443', http: '80', git: '9418' };

function refuseUnreadable(): never {
  throw refusal('invalid_argument', 'handoff_note could not read a repository from repo; pass git remote get-url origin, or the repository\'s absolute path');
}

/**
 * The repository's key. Two spellings get the same key only when they name the same repository; anything that can name a
 * different one keeps them apart:
 *
 * - A remote is `remote:` + host + path. Credentials are dropped (never stored). The host is lowercased; a port is kept
 *   unless it is the scheme's default (22 for ssh and the scp form `git@host:path`, 443 https, 80 http, 9418 git).
 *   https and http count as one transport and ssh and the scp form as another, and on a host not listed in
 *   FOLDING_HOSTS the transport is part of the key (`remote:https//host/path`, `remote:ssh//host/path`), since one host
 *   may serve different repositories over each.
 * - On github.com, gitlab.com, bitbucket.org and codeberg.org the transport and the user are dropped, the path is
 *   lowercased, a leading `/` or `~/`, repeated and trailing slashes and one trailing `.git` are folded:
 *   `git@github.com:Acme/Fjord.git` and `https://github.com/acme/fjord` are one repository there.
 * - Anywhere else the path is kept as git sends it to the server, byte for byte (case, `.git`, repeated and trailing
 *   slashes). A path relative to the login's home (`git@host:acme/fjord`, `ssh://host/~/acme/fjord`) is keyed with the
 *   user, `remote:ssh-home//git@host|acme/fjord`, and never meets a root-absolute one (`git@host:/acme/fjord`).
 * - A repository with no remote is `path:` + its absolute path, byte for byte except a trailing slash (`/srv/fjord.git`
 *   and `/srv/fjord` are two folders). A Windows path keeps its spelling with `\` written as `/`.
 *
 * The key is never cut: one longer than 600 characters is refused. Throws on an empty or unusable value.
 */
export function normaliseRepoKey(raw: string): string {
  const input = (raw ?? '').trim();
  if (!input) throw refusal('missing_argument', 'handoff_note needs repo: the repository\'s remote URL (git remote get-url origin), or its absolute path when it has none');
  let key: string;
  const windows = /^[A-Za-z]:[\\/]/.test(input);
  if (input.startsWith('/') || windows || /^file:\/\//i.test(input)) {
    let local = input.replace(/^file:\/\//i, '');
    if (windows) local = local.replace(/\\/g, '/');
    local = local.replace(/(.)\/+$/, '$1');
    if (!local.startsWith('/') && !/^[A-Za-z]:\//.test(local)) refuseUnreadable();
    key = `path:${local}`;
  } else {
    let transport: string;
    let user = '';
    let host: string;
    let port: string | undefined;
    // The path as git sends it to the server: `acme/fjord` (home-relative) and `/acme/fjord` (root-absolute) are two
    // repositories on an ssh server (`git-upload-pack 'acme/fjord'` against `git-upload-pack '/acme/fjord'`).
    let gitPath: string;
    const url = /^([a-z][a-z0-9+.-]*):\/\/(?:([^/@:]*)(?::[^/@]*)?@)?(\[[^\]]+\]|[^/:@]+)(?::(\d*))?(\/.*)?$/i.exec(input);
    if (url) {
      const scheme = url[1].toLowerCase();
      transport = scheme === 'http' || scheme === 'https' ? 'https' : scheme === 'ssh' || scheme === 'git+ssh' || scheme === 'ssh+git' ? 'ssh' : scheme;
      user = url[2] ?? '';
      host = url[3].toLowerCase();
      port = url[4] && url[4] !== DEFAULT_PORTS[scheme] ? url[4] : undefined;
      const urlPath = url[5] ?? '';
      // git sends ssh://host/~/x and ssh://host/~user/x as `~/x` and `~user/x`, as it does the scp form host:~/x.
      gitPath = transport === 'ssh' && urlPath.startsWith('/~') ? urlPath.slice(1) : urlPath;
    } else {
      // scp-like: [user@]host:path, which git reads as ssh on port 22, the path sent as written.
      const scp = /^(?:([^@/:]+)@)?(\[[^\]]+\]|[^:/@]+):(.+)$/.exec(input);
      if (!scp) refuseUnreadable();
      transport = 'ssh';
      user = scp[1] ?? '';
      host = scp[2].toLowerCase();
      gitPath = scp[3];
    }
    if (!host || !gitPath || gitPath === '/') refuseUnreadable();
    const authority = port ? `${host}:${port}` : host;
    if (FOLDING_HOSTS.has(host) && !port) {
      // These hosts serve `owner/repo` the same whether it is written relative or absolute, by any user.
      key = `remote:${authority}/${gitPath.replace(/^~?\/*/, '').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase().replace(/\.git$/, '')}`;
    } else if (gitPath.startsWith('/')) {
      // Root-absolute: the path names one place on that host whoever logs in. Kept byte for byte, trailing slash included.
      key = `remote:${transport}//${authority}${gitPath}`;
    } else {
      // Relative to the login's home (ssh only): the user is part of where it is. `|` cannot appear in a user, host or
      // port, so this key never meets an absolute one or another user's.
      if (/[|\s]/.test(user)) refuseUnreadable();
      key = `remote:${transport}-home//${user}@${authority}|${gitPath}`;
    }
  }
  if (key.length > MAX_KEY_CHARS) throw refusal('field_too_long', `handoff_note repo is over ${MAX_KEY_CHARS} characters; it is never cut, so a longer one cannot be keyed`);
  assertNoUnstorableControls('handoff_note repo', key);
  return key;
}

/** `refs/heads/main` and ` main ` are `main`. A detached HEAD has no branch and is refused. Branch case is kept. */
export function normaliseBranch(raw: string): string {
  const branch = (raw ?? '').trim().replace(/^refs\/heads\//, '');
  if (!branch) throw refusal('missing_argument', 'handoff_note needs branch: git rev-parse --abbrev-ref HEAD');
  if (branch === 'HEAD') throw refusal('invalid_argument', 'handoff_note: a detached HEAD has no branch, so there is no note for it');
  if (branch.length > MAX_KEY_CHARS) throw refusal('field_too_long', `handoff_note branch is over ${MAX_KEY_CHARS} characters`);
  assertNoUnstorableControls('handoff_note branch', branch);
  return branch;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * A clock the store reads time from: the wall clock, and a monotonic one that never goes back (performance.now in a
 * process). Tests pass their own.
 */
export interface HandoffClock {
  wall(): number;
  mono?(): number;
}

const SYSTEM_CLOCK: HandoffClock = { wall: () => Date.now(), mono: () => performance.now() };

/** A caller's fixed instant: wall time only, so it can move a note's clock forward but never measures elapsed time. */
function clockOf(now: Date | undefined, clock: HandoffClock | undefined): HandoffClock {
  if (clock) return clock;
  return now ? { wall: () => now.getTime() } : SYSTEM_CLOCK;
}

/** The last instant this process gave each database, with the monotonic reading it was given at. */
const lastSeen = new WeakMap<Database.Database, { at: number; mono?: number }>();

/**
 * The time the store goes by, so a wall clock set back cannot keep a note past its 7 days. It never goes back: it is
 * the latest of the wall clock, the last instant it gave plus the monotonic time elapsed since (in this process), and
 * the high-water mark stored with the notes (across restarts). Limit: time that passes while no process runs, with the
 * wall clock set back over it, is not counted, so it can delay an expiry by that long.
 */
function storeNow(db: Database.Database, clock: HandoffClock): Date {
  const mono = clock.mono?.();
  let at = clock.wall();
  const seen = lastSeen.get(db);
  if (seen && seen.mono !== undefined && mono !== undefined) at = Math.max(at, seen.at + Math.max(0, mono - seen.mono));
  const stored = db.prepare('SELECT high_water FROM handoff_clock WHERE id = 1').get() as { high_water: number } | undefined;
  if (stored) at = Math.max(at, stored.high_water);
  if (!stored || at > stored.high_water) {
    db.prepare('INSERT INTO handoff_clock (id, high_water) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET high_water = excluded.high_water').run(at);
  }
  lastSeen.set(db, { at, mono: mono ?? seen?.mono });
  return new Date(at);
}

/** Databases whose last erasure's checkpoint did not complete (a reader held the WAL): every sweep retries it. */
const checkpointOwed = new WeakSet<Database.Database>();

/**
 * Checkpoints the WAL back to empty, so no older copy of an erased page is left in the -wal and the zeroed page is in
 * the database file. It does not wait for readers (busy_timeout 0 for the call): when one holds the WAL it reports false,
 * the database is marked owed, and the next sweep tries again.
 */
function checkpointNow(db: Database.Database): boolean {
  const timeout = db.pragma('busy_timeout', { simple: true }) as number;
  let done = false;
  try {
    db.pragma('busy_timeout = 0');
    const result = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    done = result[0]?.busy === 0;
  } catch {
    done = false;
  } finally {
    db.pragma(`busy_timeout = ${timeout}`);
  }
  if (done) checkpointOwed.delete(db); else checkpointOwed.add(db);
  return done;
}

/**
 * Runs `work` with secure_delete on, so the bytes a DELETE or an overwrite frees are zeroed, then checkpoints (see
 * checkpointNow). The connection's own secure_delete setting is put back afterwards.
 */
function eraseFreed<T>(db: Database.Database, work: () => T): T {
  const before = db.pragma('secure_delete', { simple: true }) as number;
  db.pragma('secure_delete = ON');
  try {
    return work();
  } finally {
    db.pragma(`secure_delete = ${before ? 'ON' : 'OFF'}`);
    checkpointNow(db);
  }
}

/** Deletes the expired notes, and any dated ahead of `now` by more than the clock skew. Returns how many it deleted. */
function purgeExpired(db: Database.Database, now: Date): number {
  const ahead = new Date(now.getTime() + HANDOFF_CLOCK_SKEW_MS).toISOString();
  const due = db.prepare('SELECT COUNT(*) AS c FROM handoff_notes WHERE expires_at <= ? OR written_at > ?')
    .get(now.toISOString(), ahead) as { c: number };
  if (due.c === 0) return 0;
  return eraseFreed(db, () => db.prepare('DELETE FROM handoff_notes WHERE expires_at <= ? OR written_at > ?')
    .run(now.toISOString(), ahead).changes);
}

/**
 * One expiry pass: deletes every due note, and retries a checkpoint an earlier erasure still owes. `firstPass` also
 * checkpoints whatever a process that stopped early left in the WAL.
 */
export function sweepHandoffNotes(db: Database.Database, clock: HandoffClock = SYSTEM_CLOCK, firstPass = false): void {
  ensureHandoffTable(db);
  const deleted = purgeExpired(db, storeNow(db, clock));
  if (deleted === 0 && (firstPass || checkpointOwed.has(db))) checkpointNow(db);
}

/**
 * The expiry sweep, independent of reads and writes: one pass now, then one every `everyMs`. Only the servers start it,
 * and only with RENOR_HANDOFF_NOTE on. Returns the function that stops it. The timer never keeps a process alive.
 */
export function startHandoffSweep(db: Database.Database, everyMs: number = HANDOFF_SWEEP_MS, clock: HandoffClock = SYSTEM_CLOCK): () => void {
  const sweep = (firstPass: boolean) => {
    try { sweepHandoffNotes(db, clock, firstPass); } catch { /* a closed or busy database: the next sweep tries again */ }
  };
  sweep(true);
  const timer = setInterval(() => sweep(false), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Writes the note for this repository and branch, replacing any note already there (exactly one row per key; the old
 * text is overwritten on disk, see eraseFreed). A note over 200 words or 2,000 characters is refused, never cut; so is
 * text the secret guard flags. Returns what was stored.
 */
export async function writeHandoffNote(db: Database.Database, args: {
  repo: string; branch: string; note: string; writer: string; now?: Date; clock?: HandoffClock;
}): Promise<HandoffNote & { replaced: boolean }> {
  const repo = normaliseRepoKey(args.repo);
  const branch = normaliseBranch(args.branch);
  const note = (args.note ?? '').trim();
  if (!note) throw refusal('missing_argument', 'handoff_note write needs note: what was in progress, the next step, open questions');
  const words = countWords(note);
  if (words > HANDOFF_MAX_WORDS) throw refusal('field_too_long', `handoff_note is ${words} words; at most ${HANDOFF_MAX_WORDS}. Shorten it to what was in progress, the next step and open questions. Nothing was written.`);
  if (note.length > HANDOFF_MAX_CHARS) throw refusal('field_too_long', `handoff_note is ${note.length} characters; at most ${HANDOFF_MAX_CHARS}. Nothing was written.`);
  assertNoUnstorableControls('handoff_note note', note);
  await assertStorable([{ field: 'note', text: note }]);
  const writer = args.writer.trim() || 'unnamed';
  ensureHandoffTable(db);
  const now = storeNow(db, clockOf(args.now, args.clock));
  const writtenAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + HANDOFF_TTL_MS).toISOString();
  purgeExpired(db, now);
  const replaced = eraseFreed(db, () => db.transaction(() => {
    const had = db.prepare('SELECT 1 FROM handoff_notes WHERE repo = ? AND branch = ?').get(repo, branch) !== undefined;
    db.prepare(`INSERT INTO handoff_notes (repo, branch, note, writer, written_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo, branch) DO UPDATE SET note = excluded.note, writer = excluded.writer,
        written_at = excluded.written_at, expires_at = excluded.expires_at`)
      .run(repo, branch, note, writer, writtenAt, expiresAt);
    return had;
  })());
  return { repo, branch, note, writer, written_at: writtenAt, expires_at: expiresAt, replaced };
}

/**
 * The note for exactly this repository and branch, or null: none was written, it is 7 days old, or it is dated ahead of
 * the clock. Another branch or another repository never matches. Reading also deletes every due note in the workspace.
 */
export function readHandoffNote(db: Database.Database, args: { repo: string; branch: string; now?: Date; clock?: HandoffClock }): HandoffNote | null {
  const repo = normaliseRepoKey(args.repo);
  const branch = normaliseBranch(args.branch);
  ensureHandoffTable(db);
  purgeExpired(db, storeNow(db, clockOf(args.now, args.clock)));
  const row = db.prepare('SELECT repo, branch, note, writer, written_at, expires_at FROM handoff_notes WHERE repo = ? AND branch = ?')
    .get(repo, branch) as HandoffNote | undefined;
  return row ?? null;
}

/**
 * The note as an agent shows it at session start: its date, its writer, and its age, then the note. Status, so it is
 * labelled as possibly out of date and as agent text.
 */
export function presentHandoffNote(note: HandoffNote, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(note.written_at)) / (24 * 60 * 60 * 1000));
  const age = days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `Handoff note for ${note.branch}, written ${note.written_at.slice(0, 16).replace('T', ' ')} UTC (${age}) by ${note.writer}. `
    + 'It is the last session\'s status, not memory: check it against the code before relying on it.\n\n'
    + note.note;
}

export const HANDOFF_TOOL_NAME = 'handoff_note';

export const HANDOFF_TOOL_DESCRIPTION =
  'The handoff note for one repository and branch: the only status Renor keeps, and never memory. '
  + 'action "write" at the end of a session: what was in progress, the next step, open questions, in at most 200 words. It replaces the note already there; nothing is appended. '
  + 'action "read" at the start of a session: the note for exactly this repository and branch, with its date and the agent that wrote it, or found: false. '
  + 'repo is `git remote get-url origin` (or the repository\'s absolute path when it has no remote), branch is `git rev-parse --abbrev-ref HEAD`. '
  + 'A note is deleted 7 days after it was written. get_context, search_memory, memory_map, whats_new and export_memory never return it. Do not save status anywhere else.';

export const HANDOFF_ARG_DESCRIPTIONS = {
  action: '"write" to replace this repository and branch\'s note, "read" to get it.',
  repo: 'The repository: git remote get-url origin, or its absolute path when it has no remote. Credentials in a URL are dropped, never stored.',
  branch: 'The branch: git rev-parse --abbrev-ref HEAD.',
  note: 'For write: what was in progress, the next step, open questions. At most 200 words.',
} as const;

/**
 * The one entry both MCP servers call (the hosted `handoff_note` tool and the stdio one), and the documented function
 * a private gate runs: `runHandoffTool(db, { action, repo, branch, note? }, writer, now?)`. `writer` is the connection's
 * authenticated name. Returns the reply body; throws a refusal on bad input.
 */
export async function runHandoffTool(db: Database.Database, args: {
  action: 'read' | 'write'; repo: string; branch: string; note?: string;
}, writer: string, now?: Date): Promise<Record<string, unknown>> {
  if (args.action === 'write') {
    const stored = await writeHandoffNote(db, { repo: args.repo, branch: args.branch, note: args.note ?? '', writer, now });
    return {
      ok: true, action: 'write', replaced: stored.replaced, repo: stored.repo, branch: stored.branch,
      writer: stored.writer, written_at: stored.written_at, expires_at: stored.expires_at, words: countWords(stored.note),
    };
  }
  if (args.action !== 'read') throw refusal('invalid_argument', 'handoff_note action is "read" or "write"');
  const found = readHandoffNote(db, { repo: args.repo, branch: args.branch, now });
  if (!found) return { ok: true, action: 'read', found: false, repo: normaliseRepoKey(args.repo), branch: normaliseBranch(args.branch) };
  return { ok: true, action: 'read', found: true, ...found, shown: presentHandoffNote(found, now ?? new Date()) };
}
