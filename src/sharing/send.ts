import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { learningDbPath, learningRetentionDays } from '../learning/settings';
import { LearningLog } from '../learning/store';
import { ExampleStore } from './examples';
import {
  CLI_WORDING_VERSION, MAX_ROWS_PER_BATCH, SHARING_PROTOCOL, TERMINAL_REFUSALS, levelRank, validateRow, type SharingLevel,
} from './fields';
import { LABEL_WINDOW_MS, projectRows, type ProjectedKind, type ProjectedRow } from './project';
import {
  EXAMPLES_FILE, effectiveLevel, ensureState, envOverride, freshState, readConsent, readState, removeLocalSharingData,
  writeConsent, writeState, type ConsentRecord, type SharingState,
} from './state';
import path from 'node:path';

/**
 * The sender, and the changes to the choice. Everything that leaves the machine leaves through `post` below, and only from
 * `shareNow` (rows), `deleteRemote` (a removal request with no data in it).
 *
 * The rules, each with a test:
 *   - level off sends nothing and writes nothing new (no file is made or opened except to read);
 *   - signals sends the signals fields; data sends the same plus the text fields; the rows are checked against
 *     fields.ts before a request is made, so a bug cannot widen what leaves;
 *   - debug mode builds the exact request body and returns it without sending and without moving any watermark;
 *   - a change of choice takes effect at the next call, in this process or another: the level is read from the record each time;
 *   - a run reads the choice again before each request and after it; when off was chosen meanwhile, it sends nothing more and
 *     asks the endpoint to delete what it holds (a request already on the wire may land after the deletion `off` asked for);
 *   - at `data`, an example text is deleted once every row that can use it has been sent;
 *   - a self-hosted batch carries the install's consent record (fields.ts CONSENT_FIELDS), which the endpoint requires;
 *   - a refusal the endpoint means for good (fields.ts TERMINAL_REFUSALS) is never retried: the refused rows are never sent again,
 *     `consent_off` applies off here, and `sharing_closed` or `consent_required` pause sending until the sharing status says open
 *     again or the person chooses a level again. A deletion is never paused.
 */

/** The endpoint the sender posts to. RENOR_SHARING_ENDPOINT replaces it (it must be https, or loopback for a test). */
export const DEFAULT_ENDPOINT = 'https://yiotrpmsxbnarzvodqyf.supabase.co/functions/v1/sharing-ingest';

export function sharingEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RENOR_SHARING_ENDPOINT ?? '').trim();
  if (raw === '') return DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('RENOR_SHARING_ENDPOINT must be a URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('RENOR_SHARING_ENDPOINT must be https (http is allowed only for a loopback address)');
  }
  return url.toString();
}

/** Renor's public sharing switch (the gateway's GET /sharing/status, one bit). RENOR_SHARING_STATUS_URL replaces it. */
export const DEFAULT_STATUS_URL = 'https://mcp.renor.cloud/sharing/status';

export function sharingStatusUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RENOR_SHARING_STATUS_URL ?? '').trim();
  if (raw === '') return DEFAULT_STATUS_URL;
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('RENOR_SHARING_STATUS_URL must be https (http is allowed only for a loopback address)');
  }
  return url.toString();
}

/** Whether Renor's switch is open: only an answer of exactly {"open": true} is open; any error, redirect or other answer is closed. */
export async function sharingStatusOpen(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(sharingStatusUrl(env), { method: 'GET', redirect: 'manual', signal: controller.signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body: unknown = JSON.parse(await readCapped(response));
    return typeof body === 'object' && body !== null && JSON.stringify(body) === '{"open":true}';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function debugOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_SHARING_DEBUG ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** A reply as the sender reads it. `body` is the stream fetch gives; without one (a test's fake), `text()` is read. */
export interface Reply {
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}
export type Post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Reply>;

/** The most of a reply body the sender reads: a refusal is a short JSON object, so anything longer is cut and the rest cancelled. */
export const MAX_REPLY_BYTES = 4096;

/** Reads at most MAX_REPLY_BYTES of a reply and cancels the rest, so an endpoint (or anything in between) cannot make it read more. */
export async function readCapped(reply: Pick<Reply, 'text' | 'body'>, max = MAX_REPLY_BYTES): Promise<string> {
  const stream = reply.body;
  if (!stream) return (await reply.text()).slice(0, max);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

export interface SenderOptions {
  /** The sharing folder (consent record, state, example store). */
  dir: string;
  /** The memory folder whose learning log the rows are made from; null when there is none (nothing to send). */
  memoryDir: string | null;
  env?: NodeJS.ProcessEnv;
  fetch?: Post;
  now?: () => number;
  /**
   * This sender runs behind the hosted gateway. The endpoint then accepts rows only for a contributor the platform has tied to a
   * workspace whose consent record in the control plane allows the level. A self-hosted install leaves it unset.
   */
  hosted?: boolean;
  /** Label window (ms), for tests. */
  windowMs?: number;
  /** Asks whether Renor's sharing switch is open (default: sharingStatusOpen), only while a `sharing_closed` refusal pauses sending. */
  sharingOpen?: () => Promise<boolean>;
  /** Return the request bodies instead of sending them. Also on with RENOR_SHARING_DEBUG=1. */
  debug?: boolean;
  /**
   * Debug only: build the bodies for this level even though the user has not chosen it, so a person can see exactly what a
   * level would send before they pick it. Ignored unless the run is a debug run, so it can never cause a send.
   */
  previewLevel?: Exclude<SharingLevel, 'off'>;
}

export type ShareStatus = 'off' | 'no-log' | 'nothing' | 'debug' | 'sent' | 'failed' | 'stopped' | 'paused';
export interface ShareResult {
  status: ShareStatus;
  level: SharingLevel;
  rows: number;
  batches: number;
  skipped: number;
  /** debug: the exact bodies that would be sent. */
  payloads?: unknown[];
  reason?: string;
}

async function post(url: string, bearer: string, body: string, send: Post | undefined, hosted = false): Promise<{ status: number; retryAfter: number | null; code: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const doFetch: Post = send ?? ((u, init) => fetch(u, init));
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...(hosted ? { 'x-renor-hosted': '1' } : {}) },
      body,
      signal: controller.signal,
    });
    const retry = Number(response.headers.get('retry-after'));
    // The refusal's code, from the endpoint's JSON body ({"ok": false, "code": ...}); null when there is none.
    let code: string | null = null;
    if (response.status >= 400) {
      try {
        const parsed: unknown = JSON.parse(await readCapped(response));
        if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { code?: unknown }).code === 'string') code = (parsed as { code: string }).code;
      } catch {
        // An unreadable body is an ordinary failure, retried.
      }
    }
    return { status: response.status, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null, code };
  } finally {
    clearTimeout(timer);
  }
}

/** Splits rows (oldest first) into batches of at most `max`, never between two rows with the same time, so a watermark is exact. */
function chunk(rows: ProjectedRow[], max: number): ProjectedRow[][] {
  const out: ProjectedRow[][] = [];
  let index = 0;
  while (index < rows.length) {
    let end = Math.min(index + max, rows.length);
    while (end < rows.length && end > index + 1 && rows[end]!.at === rows[end - 1]!.at) end -= 1;
    out.push(rows.slice(index, end));
    index = end;
  }
  return out;
}

function batchId(state: SharingState, kind: ProjectedKind, rows: ProjectedRow[]): string {
  // The same chunk gets the same id on a retry, so an answer lost on the way never makes the endpoint store it twice.
  return createHash('sha256')
    .update(JSON.stringify([state.secret, kind, rows[0]!.at, rows[rows.length - 1]!.at, rows.length]))
    .digest('hex')
    .slice(0, 32);
}

/** Computes the rows that are final and unsent, and sends them (or, in debug mode, returns the bodies). */
export async function shareNow(options: SenderOptions): Promise<ShareResult> {
  const env = options.env ?? process.env;
  const now = (options.now ?? Date.now)();
  const debug = options.debug === true || debugOn(env);
  const previewing = debug && options.previewLevel !== undefined;
  const level: SharingLevel = previewing ? options.previewLevel! : effectiveLevel(options.dir, env);
  const empty = (status: ShareStatus, extra: Partial<ShareResult> = {}): ShareResult =>
    ({ status, level, rows: 0, batches: 0, skipped: 0, ...extra });
  if (level === 'off') return empty('off');
  const record = readConsent(options.dir);
  const consent = record ?? (previewing ? { wording: CLI_WORDING_VERSION } : null);
  if (consent === null || options.memoryDir === null) return empty('no-log', { reason: 'no learning log to read' });

  // A refusal for good paused sending: nothing goes out until it clears (debug only builds bodies, so it ignores the pause).
  const paused = debug ? undefined : readState(options.dir)?.paused;
  if (paused?.code === 'consent_required') {
    return empty('paused', { reason: 'Renor refused the consent record; nothing is sent until a level is chosen again' });
  }
  if (paused?.code === 'sharing_closed') {
    if (!(await (options.sharingOpen ?? (() => sharingStatusOpen(env)))())) {
      return empty('paused', { reason: 'Renor has closed sharing; nothing is sent until it is open again' });
    }
    const resumed = readState(options.dir);
    if (resumed !== null) {
      delete resumed.paused;
      writeState(options.dir, resumed);
    }
  }

  const file = learningDbPath(options.memoryDir);
  if (!fs.existsSync(file)) return empty('no-log', { reason: `no learning log at ${file}` });

  const log = LearningLog.open(file, { retentionDays: learningRetentionDays(env), rawQueries: false, create: false, now: () => now });
  if (log === null) return empty('no-log', { reason: `no learning log at ${file}` });
  let exported;
  try {
    exported = log.exportLog();
  } finally {
    log.close();
  }

  // Debug reads the state if there is one and never makes it; a real send makes it on first use.
  const state = debug ? (readState(options.dir) ?? freshState()) : ensureState(options.dir);
  const examples = level === 'data' ? ExampleStore.open(options.dir, false) : null;
  let projected: ProjectedRow[];
  try {
    projected = projectRows(exported, { level, now, windowMs: options.windowMs, watermarks: state.watermarks, examples });
  } finally {
    examples?.close();
  }

  let skipped = 0;
  const valid = projected.filter(item => {
    try {
      validateRow(item.row, level);
      return true;
    } catch {
      skipped += 1;
      return false;
    }
  });
  // A row that fails its own contract is never sent. Its time still passes the watermark (below), so it cannot block the rest.
  const byKind = new Map<ProjectedKind, ProjectedRow[]>();
  for (const item of valid) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  const batches: Array<{ kind: ProjectedKind; rows: ProjectedRow[] }> = [];
  for (const [kind, rows] of byKind) {
    rows.sort((a, b) => a.at - b.at);
    for (const part of chunk(rows, MAX_ROWS_PER_BATCH)) batches.push({ kind, rows: part });
  }
  // Every row older than the label window is final, so it is sent once the run sends all it has; the texts only such rows use
  // are no longer needed. A text a later event still needs was put again at that event, which keeps it.
  const forgetSentExamples = (): void => {
    if (level !== 'data') return;
    const store = ExampleStore.open(options.dir, false);
    try {
      store?.forgetUpTo(now - (options.windowMs ?? LABEL_WINDOW_MS));
    } finally {
      store?.close();
    }
  };
  if (batches.length === 0) {
    if (!debug) forgetSentExamples();
    return empty('nothing', { skipped });
  }

  // The consent record a self-hosted batch carries (the endpoint refuses one without it). A preview has no record yet: it shows
  // the one choosing that level would make.
  const evidence = {
    version: 1,
    level: record?.level ?? level,
    changed_at: record?.changedAt ?? new Date(now).toISOString(),
    wording: consent.wording,
    adult: record ? record.adult === true : true,
  };
  const body = (kind: ProjectedKind, rows: ProjectedRow[]): Record<string, unknown> => ({
    protocol: SHARING_PROTOCOL,
    action: 'batch',
    batch_id: batchId(state, kind, rows),
    level,
    wording: consent.wording,
    rows: rows.map(item => item.row),
    ...(options.hosted ? {} : { consent: evidence }),
  });

  if (debug) {
    const payloads = batches.map(batch => body(batch.kind, batch.rows));
    return { status: 'debug', level, rows: valid.length, batches: payloads.length, skipped, payloads };
  }

  const endpoint = sharingEndpoint(env);
  let sent = 0;
  let sentBatches = 0;
  const stillChosen = (): boolean => levelRank(effectiveLevel(options.dir, env)) >= levelRank(level);
  const stopped = (): ShareResult => ({ status: 'stopped', level, rows: sent, batches: sentBatches, skipped, reason: 'the choice was lowered during the run' });
  for (const batch of batches) {
    if (!stillChosen()) return stopped();
    // Recorded before the request, so an `off` chosen while it is on the wire knows there may be something to delete.
    state.everSent = true;
    writeState(options.dir, state);
    let status: number | null = null;
    let code: string | null = null;
    let failure: string | null = null;
    try {
      ({ status, code } = await post(endpoint, state.secret, JSON.stringify(body(batch.kind, batch.rows)), options.fetch, options.hosted));
    } catch (err) {
      failure = err instanceof Error ? err.message : 'request failed';
    }
    // Off was chosen while the request was out: it may have landed after the deletion off asked for, so ask again.
    if (effectiveLevel(options.dir, env) === 'off') {
      const removal = await requestDelete(options.dir, state, { env, fetch: options.fetch, hosted: options.hosted });
      if (removal.ok) removeLocalSharingData(options.dir);
      return { ...stopped(), reason: 'off was chosen during the run; the endpoint was asked to delete what it holds' };
    }
    if (failure !== null || status === null) {
      return { status: 'failed', level, rows: sent, batches: sentBatches, skipped, reason: failure ?? 'request failed' };
    }
    const last = batch.rows[batch.rows.length - 1]!.at;
    const key = batch.kind === 'retrieval' ? 'retrieval' : batch.kind === 'save' ? 'save' : 'session';
    if ((status < 200 || status >= 300) && code !== null && (TERMINAL_REFUSALS as readonly string[]).includes(code)) {
      // Refused for good: these rows are never sent again, whatever happens next, and nothing more is sent now.
      state.watermarks[key] = Math.max(state.watermarks[key], last);
      if (code === 'consent_off') {
        writeState(options.dir, state);
        // The workspace's record says off: apply it here, as choosing off does (it also asks for the deletion).
        await chooseLevel({
          dir: options.dir, level: 'off', wording: consent.wording, adult: record?.adult === true, source: 'service',
          env, fetch: options.fetch, now: options.now, hosted: options.hosted,
        });
        return { ...stopped(), reason: 'Renor says sharing is off for this workspace; it is now off here too' };
      }
      state.paused = { code: code as 'sharing_closed' | 'consent_required', at: now };
      writeState(options.dir, state);
      return {
        status: 'paused', level, rows: sent, batches: sentBatches, skipped,
        reason: code === 'sharing_closed'
          ? 'Renor has closed sharing; nothing is sent until it is open again'
          : 'Renor refused the consent record; nothing is sent until a level is chosen again',
      };
    }
    if (status < 200 || status >= 300) {
      return { status: 'failed', level, rows: sent, batches: sentBatches, skipped, reason: `the endpoint answered ${status}` };
    }
    state.watermarks[key] = Math.max(state.watermarks[key], last);
    state.everSent = true;
    writeState(options.dir, state);
    sent += batch.rows.length;
    sentBatches += 1;
  }
  // Rows that failed the contract also move the watermark, so they are not recomputed forever.
  if (skipped > 0) {
    for (const item of projected) {
      if (valid.includes(item)) continue;
      const key = item.kind;
      state.watermarks[key] = Math.max(state.watermarks[key], item.at);
    }
    writeState(options.dir, state);
  }
  forgetSentExamples();
  return { status: 'sent', level, rows: sent, batches: sentBatches, skipped };
}

export interface RemoteDeleteResult {
  /** The endpoint holds nothing of this contributor now (or never did). */
  ok: boolean;
  /** A request was made. False when nothing had ever been sent, or when DO_NOT_TRACK=1 forbade it. */
  requested: boolean;
  /** DO_NOT_TRACK=1 forbade the request: the deletion is recorded here as owed and sent by the first run without it. */
  owedUnderDoNotTrack?: boolean;
  reason?: string;
}

const doNotTrack = (env: NodeJS.ProcessEnv): boolean => (env.DO_NOT_TRACK ?? '').trim() === '1';

/**
 * Asks the endpoint to delete everything it holds for this contributor. A request is made only if rows were ever sent: an
 * install that never shared sends nothing, even to be deleted. When the endpoint cannot be reached, the removal stays owed
 * (deletePending) and is tried again by the next sender run.
 */
export async function deleteRemote(options: Pick<SenderOptions, 'dir' | 'env' | 'fetch' | 'hosted'>): Promise<RemoteDeleteResult> {
  const state = readState(options.dir);
  if (state === null || (!state.everSent && !state.deletePending)) return { ok: true, requested: false };
  return requestDelete(options.dir, state, options);
}

/** The removal request for the contributor `state` names. A failure leaves the removal owed (deletePending) in `dir`. */
async function requestDelete(dir: string, state: SharingState, options: Pick<SenderOptions, 'env' | 'fetch' | 'hosted'>): Promise<RemoteDeleteResult> {
  const env = options.env ?? process.env;
  if (doNotTrack(env)) {
    // No request may be made from this process. The deletion is still owed: keep the secret it needs and mark it pending, so the
    // first run without DO_NOT_TRACK=1 sends it (settlePendingDelete).
    writeState(dir, { ...state, everSent: true, deletePending: true });
    return {
      ok: false, requested: false, owedUnderDoNotTrack: true,
      reason: 'DO_NOT_TRACK=1 forbids any request, so the deletion is recorded here and sent the first time the engine runs without it',
    };
  }
  try {
    const { status } = await post(
      sharingEndpoint(env), state.secret, JSON.stringify({ protocol: SHARING_PROTOCOL, action: 'delete' }), options.fetch, options.hosted);
    if (status >= 200 && status < 300) return { ok: true, requested: true };
    // 401 on a contributor the endpoint no longer knows is the same as gone.
    if (status === 401 || status === 404) return { ok: true, requested: true };
    writeState(dir, { ...state, everSent: true, deletePending: true });
    return { ok: false, requested: true, reason: `the endpoint answered ${status}` };
  } catch (err) {
    writeState(dir, { ...state, everSent: true, deletePending: true });
    return { ok: false, requested: true, reason: err instanceof Error ? err.message : 'request failed' };
  }
}

export interface ChooseOptions {
  dir: string;
  level: SharingLevel;
  wording: string;
  adult: boolean;
  source: ConsentRecord['source'];
  env?: NodeJS.ProcessEnv;
  fetch?: Post;
  now?: () => number;
  hosted?: boolean;
}

export interface ChooseResult {
  level: SharingLevel;
  changed: boolean;
  record: ConsentRecord | null;
  /** Off only: the endpoint was asked to delete (true), or could not be reached or DO_NOT_TRACK=1 forbade it, and it will be asked again (false), or had nothing (null). */
  remoteDeleted: boolean | null;
  /** Off only: DO_NOT_TRACK=1 forbade the deletion request; it is owed and sent by the first run without it. */
  deleteOwedUnderDoNotTrack?: boolean;
  reason?: string;
}

/** Records a choice. Off with nothing ever chosen writes nothing; leaving `data` deletes the example texts at once. */
export async function chooseLevel(options: ChooseOptions): Promise<ChooseResult> {
  const previous = readConsent(options.dir);
  const now = (options.now ?? Date.now)();
  if (options.level === 'off') {
    if (previous === null) return { level: 'off', changed: false, record: null, remoteDeleted: null };
    const record: ConsentRecord = { version: 1, level: 'off', changedAt: new Date(now).toISOString(), wording: options.wording, adult: previous.adult, source: options.source };
    writeConsent(options.dir, record);
    // Stop first: from this write on, no process records or sends anything. Then owe the deletion before discarding anything,
    // so a process that dies here leaves it pending (with the secret it needs) for settlePendingDelete.
    const owed = readState(options.dir);
    if (owed !== null && owed.everSent && !owed.deletePending) writeState(options.dir, { ...owed, deletePending: true });
    for (const name of [EXAMPLES_FILE, `${EXAMPLES_FILE}-wal`, `${EXAMPLES_FILE}-shm`]) fs.rmSync(path.join(options.dir, name), { force: true });
    const result = await deleteRemote({ dir: options.dir, env: options.env, fetch: options.fetch, hosted: options.hosted });
    // The secret is removed only once the endpoint holds nothing; until then the state keeps it, with the deletion pending.
    if (result.ok) removeLocalSharingData(options.dir);
    const deleted = result.requested || result.owedUnderDoNotTrack ? result.ok : null;
    return {
      level: 'off', changed: previous.level !== 'off', record, remoteDeleted: deleted, reason: result.reason,
      ...(result.owedUnderDoNotTrack ? { deleteOwedUnderDoNotTrack: true } : {}),
    };
  }
  if (!options.adult) throw new Error('sharing needs the user to confirm they are 18 or older');
  // Choosing a level is the person's answer to a refusal that paused sending: sending resumes, with new rows only.
  const pausedState = readState(options.dir);
  if (pausedState?.paused !== undefined) {
    delete pausedState.paused;
    writeState(options.dir, pausedState);
  }
  if (previous !== null && previous.level === options.level && previous.adult) {
    return { level: options.level, changed: false, record: previous, remoteDeleted: null };
  }
  const record: ConsentRecord = { version: 1, level: options.level, changedAt: new Date(now).toISOString(), wording: options.wording, adult: true, source: options.source };
  writeConsent(options.dir, record);
  ensureState(options.dir);
  if (levelRank(options.level) < levelRank('data')) {
    for (const name of [EXAMPLES_FILE, `${EXAMPLES_FILE}-wal`, `${EXAMPLES_FILE}-shm`]) fs.rmSync(path.join(options.dir, name), { force: true });
  }
  return { level: options.level, changed: true, record, remoteDeleted: null };
}

export interface DeleteAllResult {
  remote: RemoteDeleteResult;
  localRemoved: boolean;
}

/** Deletes what the endpoint holds and what sharing keeps here (state, example texts), and keeps the choice. */
export async function deleteAllShared(options: Pick<SenderOptions, 'dir' | 'env' | 'fetch' | 'hosted'>): Promise<DeleteAllResult> {
  const remote = await deleteRemote(options);
  if (!remote.ok) return { remote, localRemoved: false };
  removeLocalSharingData(options.dir);
  return { remote, localRemoved: true };
}

/** The retry of a removal that could not be made earlier. Called by the loop, whatever the level. */
export async function settlePendingDelete(options: Pick<SenderOptions, 'dir' | 'env' | 'fetch' | 'hosted'>): Promise<void> {
  const env = options.env ?? process.env;
  if (envOverride(env) !== null) return; // an environment override means no request at all from this process
  const state = readState(options.dir);
  if (state === null || !state.deletePending) return;
  const result = await deleteRemote(options);
  if (result.ok) removeLocalSharingData(options.dir);
}
