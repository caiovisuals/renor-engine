import { createHash, createHmac, randomBytes } from 'node:crypto';
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
  /**
   * A hosted workspace that once chose Off keeps its usage numbers off for good: its owner may later switch the text for training on and off
   * again, and the numbers must not start because of it. Set only on a hosted record; the numbers stream reads it, the text switch never clears it.
   */
  numbersOff?: true;
}

export interface SharingState {
  version: 1;
  /**
   * 32 random bytes, base64url. It makes the batch ids, and it is a hosted workspace's bearer (its contributor id is its SHA-256). A self-hosted
   * install does not send it: it sends `token`, the credential Renor issued it, and its contributor id is the SHA-256 of that.
   */
  secret: string;
  /**
   * The credential Renor issued this install when it asked (`register`: 86 base64url characters, a random id and its MAC). Absent until the
   * install first sends, and dropped when Renor refuses it (the next send asks for a new one). Never kept for a hosted workspace.
   */
  token?: string;
  /** Newest `at` (ms) of each row kind already sent. */
  watermarks: { retrieval: number; save: number; session: number };
  /**
   * A hosted workspace whose owner switched text for training on sends that text as a second contributor, apart from the usage numbers (which
   * are sent untied, under `secret`): the training contributor is tied to the workspace so the owner's switch can be held. Its own watermarks.
   */
  trainingWatermarks?: { retrieval: number; save: number; session: number };
  /**
   * Earlier install secrets of a hosted workspace, kept only here so Renor can still be asked to delete what they sent. The secret is rotated every time
   * the owner switches text for training on or off, so the numbers' id after a tied period cannot be matched to the one before it. The server never learns
   * that these belong together.
   */
  retiredSecrets?: string[];
  /** A removal of the training contributor is owed (it could not be reached when it was asked for). */
  trainingDeletePending?: boolean;
  /** Training rows were sent at some time, so the endpoint may hold some for the training contributor. */
  trainingEverSent?: boolean;
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
    ...(raw.numbersOff === true ? { numbersOff: true as const } : {}),
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
 * The level in force while the person has not chosen: the default. The shipped default is `off`, so an engine at this commit
 * changes nothing for anyone; the owner's decision (2026-10-25) is anonymous usage numbers ON by default WITH a switch, and the
 * change that turns it on is this one constant, made only with the owner's approved wording (data/renor-learning-layers/). Even
 * then nothing leaves until Renor's own switch for the default is open (the sender asks before it sends: send.ts), and a choice
 * (a consent file, including an explicit off) always wins over it. `data` is never a default: text for training is opt-in only.
 *
 * `RENOR_SHARING_DEFAULT=off|signals` replaces it for one process: an operator's setting, or a test. It does not make anyone's
 * choice for them, and `RENOR_SHARING` / `DO_NOT_TRACK` still lower whatever it says.
 */
export const SHIPPED_DEFAULT_LEVEL: 'off' | 'signals' = 'off';

export function defaultLevel(env: NodeJS.ProcessEnv = process.env): 'off' | 'signals' {
  const raw = (env.RENOR_SHARING_DEFAULT ?? '').trim().toLowerCase();
  if (raw === '') return SHIPPED_DEFAULT_LEVEL;
  if (raw === 'off' || raw === 'signals') return raw;
  throw new Error('RENOR_SHARING_DEFAULT must be off or signals');
}

/**
 * Whether the person has chosen in this folder: a consent file is there, valid or not. A file that cannot be read is a choice
 * that cannot be read, never an absence of one, so it is read as off and the default never applies over it.
 */
export function hasChosen(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, CONSENT_FILE));
    return true;
  } catch {
    return false;
  }
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
  // An install file that is there and cannot be read is an answer nobody can read: the stricter reading, off.
  if (record === null) return hasChosen(installDir) ? 'off' : null;
  return record.adult ? record.level : 'off';
}

/**
 * The level in force right now: the recorded level, or the default when the person has not chosen, lowered by the install's own
 * record (the stricter of the two wins) and by the environment. An unreadable record, an under-age user or a missing attestation
 * is `off`: a file that is there is a choice, and the default never applies over it. Read from the files at each call (a stat
 * tells whether they changed), so a choice made in another process takes effect on the next call, with no restart.
 */
export function effectiveLevel(dir: string, env: NodeJS.ProcessEnv = process.env): SharingLevel {
  const record = readConsentCached(dir);
  let level: SharingLevel = record === null ? (hasChosen(dir) ? 'off' : defaultLevel(env)) : !record.adult ? 'off' : record.level;
  const limit = installLimit(dir, env);
  if (limit !== null) level = lowerLevel(level, limit);
  const override = envOverride(env);
  if (override !== null) level = lowerLevel(level, override);
  return level;
}

/** Whether what is in force right now is the default, not a choice: nothing was chosen here and the level is above off. */
export function defaultInForce(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !hasChosen(dir) && effectiveLevel(dir, env) !== 'off';
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
    ...(isRecord(raw.trainingWatermarks)
      ? { trainingWatermarks: { retrieval: num(raw.trainingWatermarks.retrieval), save: num(raw.trainingWatermarks.save), session: num(raw.trainingWatermarks.session) } }
      : {}),
    ...(Array.isArray(raw.retiredSecrets) && raw.retiredSecrets.some(item => typeof item === 'string' && item.length >= 32)
      ? { retiredSecrets: raw.retiredSecrets.filter((item): item is string => typeof item === 'string' && item.length >= 32).slice(-50) }
      : {}),
    ...(raw.trainingEverSent === true ? { trainingEverSent: true } : {}),
    ...(raw.trainingDeletePending === true ? { trainingDeletePending: true } : {}),
    ...(typeof raw.token === 'string' && /^[A-Za-z0-9_-]{86}$/.test(raw.token) ? { token: raw.token } : {}),
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

/**
 * The bearer of a hosted workspace's training contributor: derived from the workspace's secret, so nothing new is stored, and a different
 * contributor id from the one the usage numbers are sent under (the numbers are never tied to the workspace; this one is, on purpose).
 */
export function trainingBearer(secret: string): string {
  return createHmac('sha256', secret).update('renor-sharing-training/v1').digest('base64url');
}

/**
 * A new install secret (a new untied id), the old one retired so a deletion can still be asked for it. Nothing was sent under the new one yet, and
 * the training contributor (derived from the secret) starts over. Returns the new state.
 */
export function rotateSecret(dir: string): SharingState {
  const state = ensureState(dir);
  const { trainingEverSent: _t, trainingDeletePending: _d, trainingWatermarks: _w, ...rest } = state;
  const next: SharingState = {
    ...rest,
    secret: randomBytes(32).toString('base64url'),
    retiredSecrets: [...(state.retiredSecrets ?? []), ...(state.everSent || state.deletePending ? [state.secret] : [])].slice(-50),
    everSent: false,
  };
  writeState(dir, next);
  return next;
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
