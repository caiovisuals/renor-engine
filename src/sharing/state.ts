import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSharingLevel, lowerLevel, type SharingLevel } from './fields';

/**
 * Where sharing keeps what it knows, and who may change it.
 *
 * Two small files in one owner-only folder (the sharing folder):
 *   sharing.json        the consent record: the level, when it was chosen, the wording version the user saw, whether they
 *                       attested to being an adult, and who set it. One per install (self-hosted) or per workspace (hosted).
 *   sharing-state.json  what the sender needs between runs: the random secret that makes the contributor id, how far each row
 *                       kind has been sent, and whether rows were ever sent (only then does `off` have anything to remove).
 *
 * No file exists until a user picks a level above off. A folder where the user never chose has neither file, and reading its
 * level is `off`. Off writes nothing: the record of an off choice is made only when there was a level to turn off.
 */

export const CONSENT_FILE = 'sharing.json';
export const STATE_FILE = 'sharing-state.json';
/** The text of examples a `data` choice keeps until it is sent; it lives next to the two files. */
export const EXAMPLES_FILE = 'sharing-examples.sqlite';

export interface ConsentRecord {
  version: 1;
  level: SharingLevel;
  /** ISO instant the level was last chosen. */
  changedAt: string;
  /** The id of the words the user saw when they chose it (CLI_WORDING_VERSION, or the dashboard's own id). */
  wording: string;
  /** The user said they are 18 or older. Required for every level above off. */
  adult: boolean;
  /** Where the choice was made. */
  source: 'cli' | 'setup' | 'dashboard' | 'service';
}

export interface SharingState {
  version: 1;
  /** 32 random bytes, base64url. The contributor id is its SHA-256; the secret never leaves this file except as a bearer token. */
  secret: string;
  /** Newest `at` (ms) of each row kind already sent. */
  watermarks: { retrieval: number; save: number; session: number };
  /** Rows were sent at some time, so the endpoint may hold some for this contributor. */
  everSent: boolean;
  /** A removal is owed to the endpoint (it could not be reached when it was asked for). Retried before anything else. */
  deletePending: boolean;
  /**
   * The endpoint refused a batch for good, so nothing is sent until this clears: `sharing_closed` (Renor's switch is off) clears
   * when the sharing status says open again, `consent_required` when the person chooses a level again. Absent when sending.
   */
  paused?: { code: 'sharing_closed' | 'consent_required'; at: number };
}

/**
 * Whether this engine runs behind the hosted gateway: the same rule as the service (mvp/config.ts reads MVP_GATEWAY_SECRET as
 * gatewaySecret, and mvp/cli.ts starts the sender with hosted: Boolean(config.gatewaySecret)), so the CLI sends as the service does.
 */
export function hostedEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MVP_GATEWAY_SECRET ?? '').trim() !== '';
}

/** The folder of a self-hosted install: RENOR_SHARING_DIR, else the user's config folder. */
export function defaultSharingDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.RENOR_SHARING_DIR ?? '').trim();
  if (set !== '') return path.resolve(set);
  const xdg = (env.XDG_CONFIG_HOME ?? '').trim();
  return path.join(xdg !== '' ? path.resolve(xdg) : path.join(os.homedir(), '.config'), 'renor');
}

/**
 * The sharing folder for a run: an explicit folder, else RENOR_SHARING_DIR, else the one inside the memory folder when there is
 * one (a service, or a command given its memory folder: the choice is per memory folder, so per workspace), else the user's
 * config folder (one choice per install).
 */
export function sharingDirFor(memoryDir: string | null, env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return path.resolve(explicit);
  if ((env.RENOR_SHARING_DIR ?? '').trim() !== '') return defaultSharingDir(env);
  return memoryDir !== null ? workspaceSharingDir(memoryDir) : defaultSharingDir(env);
}

/** The folder of one hosted workspace: inside its memory folder, so it goes with the memory on deletion. */
export function workspaceSharingDir(memoryDir: string): string {
  return path.join(path.resolve(memoryDir), '.memory-index', 'sharing');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function writeJson(dir: string, name: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The consent record, or null when none was made (or the file is unreadable: unreadable is never read as consent). */
export function readConsent(dir: string): ConsentRecord | null {
  const raw = readJson(path.join(dir, CONSENT_FILE));
  if (!isRecord(raw) || raw.version !== 1 || !isSharingLevel(raw.level)) return null;
  const sources = ['cli', 'setup', 'dashboard', 'service'];
  if (typeof raw.changedAt !== 'string' || typeof raw.wording !== 'string' || typeof raw.adult !== 'boolean') return null;
  if (typeof raw.source !== 'string' || !sources.includes(raw.source)) return null;
  return {
    version: 1,
    level: raw.level,
    changedAt: raw.changedAt,
    wording: raw.wording,
    adult: raw.adult,
    source: raw.source as ConsentRecord['source'],
  };
}

export function writeConsent(dir: string, record: ConsentRecord): void {
  writeJson(dir, CONSENT_FILE, record);
}

/** `RENOR_SHARING`: off, signals or data. It can only lower what the record says, never raise it: consent needs a record. */
export function envOverride(env: NodeJS.ProcessEnv = process.env): SharingLevel | null {
  if ((env.DO_NOT_TRACK ?? '').trim() === '1') return 'off';
  const raw = (env.RENOR_SHARING ?? '').trim().toLowerCase();
  if (raw === '') return null;
  if (!isSharingLevel(raw)) throw new Error('RENOR_SHARING must be off, signals or data');
  return raw;
}

/**
 * The install's own record (the one `renor setup` and a command without a memory folder write, in defaultSharingDir) as a
 * limit on another sharing folder on this install, a workspace's: null when there is no install record, or when `dir` is that
 * folder itself. It only ever lowers: a workspace with no record of its own stays off whatever the install says.
 */
export function installLimit(dir: string, env: NodeJS.ProcessEnv = process.env): SharingLevel | null {
  const installDir = defaultSharingDir(env);
  if (path.resolve(dir) === installDir) return null;
  const record = readConsentCached(installDir);
  if (record === null) return null;
  return record.adult ? record.level : 'off';
}

/**
 * The level in force right now: the recorded level, lowered by the install's own record (the stricter of the two wins) and by
 * the environment. An unreadable record, an under-age user or a missing attestation is `off`. Read from the files at each call
 * (a stat tells whether they changed), so a choice made in another process takes effect on the next call, with no restart.
 */
export function effectiveLevel(dir: string, env: NodeJS.ProcessEnv = process.env): SharingLevel {
  const record = readConsentCached(dir);
  let level: SharingLevel = record === null || !record.adult ? 'off' : record.level;
  const limit = installLimit(dir, env);
  if (limit !== null) level = lowerLevel(level, limit);
  const override = envOverride(env);
  if (override !== null) level = lowerLevel(level, override);
  return level;
}

const cache = new Map<string, { stamp: string; record: ConsentRecord | null }>();
function readConsentCached(dir: string): ConsentRecord | null {
  const file = path.join(dir, CONSENT_FILE);
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.record;
  const record = readConsent(dir);
  cache.set(file, { stamp, record });
  return record;
}

export function readState(dir: string): SharingState | null {
  const raw = readJson(path.join(dir, STATE_FILE));
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.secret !== 'string' || raw.secret.length < 32) return null;
  const marks = isRecord(raw.watermarks) ? raw.watermarks : {};
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    version: 1,
    secret: raw.secret,
    watermarks: { retrieval: num(marks.retrieval), save: num(marks.save), session: num(marks.session) },
    everSent: raw.everSent === true,
    deletePending: raw.deletePending === true,
    ...pausedOf(raw.paused),
  };
}

function pausedOf(raw: unknown): Pick<SharingState, 'paused'> {
  if (!isRecord(raw) || (raw.code !== 'sharing_closed' && raw.code !== 'consent_required')) return {};
  return { paused: { code: raw.code, at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0 } };
}

/** The public name of a contributor: the SHA-256 of its secret, in hex. The endpoint knows only this, never the secret. */
export function contributorId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function freshState(): SharingState {
  return {
    version: 1,
    secret: randomBytes(32).toString('base64url'),
    watermarks: { retrieval: 0, save: 0, session: 0 },
    everSent: false,
    deletePending: false,
  };
}

export function writeState(dir: string, state: SharingState): void {
  writeJson(dir, STATE_FILE, state);
}

/** The state, made on first use. Only a sender that has a level above off calls this. */
export function ensureState(dir: string): SharingState {
  const existing = readState(dir);
  if (existing !== null) return existing;
  const made = freshState();
  writeState(dir, made);
  return made;
}

/** Removes the files sharing keeps (the record stays: it is the proof of what was chosen, and holds no row). */
export function removeLocalSharingData(dir: string): void {
  for (const name of [STATE_FILE, EXAMPLES_FILE, `${EXAMPLES_FILE}-wal`, `${EXAMPLES_FILE}-shm`]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}
