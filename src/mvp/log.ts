/**
 * One operator-log shape for the engine, the gateway and the Edge Functions: a single JSON line
 * `{ ts, level, svc, event, ...fields, err? }`, written with console.log (info), console.warn (warn) or console.error (error).
 *
 * Source of truth: engine/src/mvp/log.ts. Byte-identical copies live at
 * engine/apps/gateway/src/shared/log.ts and supabase/functions/_shared/log.ts, because each runtime
 * deploys alone; engine/tests/mvp/structured-log.test.ts holds them equal. No imports, so it compiles
 * as CommonJS (engine), NodeNext ESM (gateway) and Deno (Edge Functions).
 *
 * What it refuses to write: field values that are not scalars, field names that are not plain identifiers,
 * keys that name a credential or private content (see SENSITIVE_KEY), and, inside every string it writes
 * (fields, the error's name, message, code and each stack frame): control and bidi characters, URL
 * queries and userinfo, bearer tokens, JWTs, known key formats, credential-labelled values, long
 * unlabelled keys, emails and absolute paths (see REDACTIONS). Strings are cut at 300 characters, so a
 * stray memory excerpt cannot leak whole.
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields, err?: unknown): void;
  error(event: string, fields?: LogFields, err?: unknown): void;
}

const MAX_STRING = 300;
const MAX_FRAMES = 5;
const RESERVED = new Set(['ts', 'level', 'svc', 'event', 'err']);
const SENSITIVE_KEY = /secret|token|password|passwd|authorization|cookie|api_?key|service_?role|dsn|credential|^body$|^text$|^content$|^query$|^memory$|^email$/i;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// C0/C1 controls, soft hyphen, zero-width and bidi controls, NEL and the Unicode line/paragraph separators: none may
// reach a log line, where they forge new lines or hide what an operator reads.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Applied in order to every string written; each step names what it takes out. */
const REDACTIONS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [CONTROL, ' '],
  // Credentials in a URL: userinfo (`scheme://user:pass@`) and the whole query string.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[redacted]@'],
  [/\?[^\s#"'<>|]*=[^\s#"'<>|]*/g, '?[redacted]'],
  // Bearer tokens, JWTs and the key formats the services Renor talks to use.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[redacted]'],
  [/\b(?:sk|pk|rk|whsec|re|phc|phx|sbp|ghp|gho|ghs|xox[abp])[_-][A-Za-z0-9_-]{12,}/g, '[redacted]'],
  // Any value labelled as a credential: `api_key=...`, `password: ...`, `x-api-key: ...`.
  [/\b((?:x-)?(?:api[_-]?key|access[_-]?key|client[_-]?secret|secret|token|password|passwd|pwd|auth|authorization|signature|sig|session|cookie|apikey))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, '$1$2[redacted]'],
  // An unlabelled long random-looking string (letters and digits, 32+): a key nobody named. UUIDs are ids, and stay.
  [/\b[A-Za-z0-9_-]{32,}\b/g, (m: string) => (UUID.test(m) || !/[0-9]/.test(m) || !/[A-Za-z]/.test(m) ? m : '[redacted]')],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]'],
  // Absolute paths: they name the tenant and the user's own files. A path relative to the memory folder stays.
  [/file:\/\/\/?[^\s()'"`,;]+/g, '[path]'],
  [/(^|[\s(\[='"`,])\/(?:[^\s/()'"`,;]+\/)+[^\s/()'"`,;:]+/g, '$1[path]'],
  [/\b[A-Za-z]:\\[^\s'"`,;]*/g, '[path]'],
];

function clean(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement as string);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

/** One stack frame: its function and the code file's name and position, never the directory it runs from. */
function cleanFrame(frame: string): string {
  return clean(frame.trim().replace(/(?:file:\/\/)?(?:\/|[A-Za-z]:\\)[^\s()]*?([^/\\\s()]+\.[cm]?[jt]sx?):(\d+):(\d+)/g, '$1:$2:$3'));
}

/** The error as it is reported everywhere: name, a cut message, an optional code and the top stack frames, each cleaned. */
export function serializeError(err: unknown): Record<string, string> {
  if (!(err instanceof Error)) return { name: 'NonError', message: clean(String(err)) };
  const out: Record<string, string> = { name: clean(String(err.name)), message: clean(String(err.message)) };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = clean(String(code));
  const frames = String(err.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)).slice(0, MAX_FRAMES);
  if (frames.length > 0) out.stack = frames.map(cleanFrame).join(' | ');
  return out;
}

/** The JSON line for one event; exported so a test can read exactly what would be written. */
export function formatLogLine(svc: string, level: LogLevel, event: string, fields: LogFields = {}, err?: unknown): string {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, svc: clean(svc), event: clean(event) };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || RESERVED.has(key) || !SAFE_KEY.test(key)) continue;
    if (SENSITIVE_KEY.test(key)) line[key] = '[redacted]';
    else if (typeof value === 'string') line[key] = clean(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) line[key] = value;
  }
  if (err !== undefined) line.err = serializeError(err);
  return JSON.stringify(line);
}

/**
 * `stderr: true` writes info lines to stderr too, for code that also runs where stdout is data (the stdio MCP server, a
 * CLI that prints JSON). This module is the only place in the engine, the gateway and the Edge Functions' shared code
 * allowed to call console; engine/tests/mvp/no-raw-console.test.ts holds that.
 */
export function createLogger(svc: string, options: { stderr?: boolean } = {}): Logger {
  const write = (level: LogLevel, event: string, fields?: LogFields, err?: unknown): void => {
    try {
      const line = formatLogLine(svc, level, event, fields, err);
      if (level === 'info' && !options.stderr) console.log(line);
      else if (level === 'info') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.error(line);
    } catch {
      // Logging must never break the product.
    }
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields, err) => write('warn', event, fields, err),
    error: (event, fields, err) => write('error', event, fields, err),
  };
}
