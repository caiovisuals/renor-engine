/**
 * The source of a memory: a short name for who or what saved it (`claude-code`, `cursor`, `executor-3`). It is stored with
 * the entry, in the daily-note header (`- [08:30:00] (cursor) ...`) and in the ledger event (`- source: cursor`), and shown
 * beside it ("by cursor").
 *
 * A client may send more than a name. An agent that builds its call by hand sometimes sends where the words came from
 * instead: a file path (`/home/ana/project/BOARD.md`), a Windows path, a URL. That is a location, not a name, and the two
 * stores each did the wrong thing with it. The daily-note header deletes every character that is not a letter, a digit or a
 * hyphen, so the whole path ran together into one word (`homeanaprojectBOARDmd`), with no limit on its length; the ledger
 * kept the path as sent, the directories of the sender's machine in it, and refused the whole save past 256 characters.
 *
 * Three rules, shared by both writers and by the hosted tools:
 *  - `cleanSource`: a location is reduced to the name it ends in and the name is cut at MAX_SOURCE_LENGTH characters. A path
 *    becomes its last component; a URL becomes its host, or with no host the last component of its path, and its userinfo
 *    (`user:password@`) is never part of what it becomes, whatever else the URL lacks or spells oddly. A `/` or `\` is what
 *    makes a source a location, whatever else it is: `crew/executor-7` is stored as `executor-7`. The ledger stores this.
 *    A control character is dropped first, as a URL parser drops a tab or a newline, so a stray one never loses the save and
 *    never hides the URL a browser would read (`ht<newline>tps://user:pw@host` is `host`).
 *    It is not a secret scanner: a URL inside a longer text is a name like any other (RENOR_SECRET_GUARD judges the rest).
 *  - `headerSource`: what a note header stores, which keeps letters, digits and hyphens only. It is `cleanSource` with every
 *    run of other characters written as one hyphen instead of deleted, so the words stay apart (`Claude Code` is
 *    `Claude-Code`, `board.md` is `board-md`).
 *  - `productFromUserAgent`: when a client names no one, the name it gives itself, the product in its User-Agent.
 * They decide what a NEW write stores and nothing more: an entry or event written earlier is read back exactly as it was
 * stored, and is never rewritten.
 */

import { hiveNameHeader } from './hiveNameHeader.cjs';

/** The longest source a write stores, in characters (code points). */
export const MAX_SOURCE_LENGTH = 40;

/** `scheme:` at the start. Group 1 is the scheme. It has two letters or more: `C:\\Users` and `C://Users` are a Windows drive, not a URL. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]+):/;

/**
 * The schemes a browser reads an authority after, whatever follows the colon: any run of `/` and `\`, none included, so
 * `https://h`, `https:/h`, `https:\h`, `https:h` and `https:///h` are one URL. Any other scheme has an authority only after two
 * separators (`ssh://h`), and a path after fewer: a browser reads `ssh:/user:pw@h` and `ssh:user:pw@h` as paths, and
 * `file:/home/ana/BOARD.md` as a path (`file` is not one of these).
 */
const WEB_SCHEME = /^(?:https?|wss?|ftp)$/i;

/** Where a URL's authority ends: its path, query or fragment starts. */
const AUTHORITY_END = /[\\/?#]/;

const SEPARATOR = /[\\/]/;
const COMPONENT_SEPARATORS = /[\\/]+/;

/** Every control character (C0, DEL and C1): the ledger refuses the first two in a field, and a URL parser drops a tab or a newline wherever it is. */
const CONTROL_CHARACTERS = /\p{Cc}+/gu;

/** The last component of a path that names something: `.` and `..` do not, and a trailing separator leaves an empty one. */
function lastComponent(location: string): string {
  const components = location.split(COMPONENT_SEPARATORS);
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i].trim();
    if (component !== '' && component !== '.' && component !== '..') return component;
  }
  return '';
}

/** At most MAX_SOURCE_LENGTH characters, counted as the code points they are, so a letter outside the BMP is never split. */
function cut(name: string): string {
  // Code units are never fewer than code points, so a short string needs no walk.
  if (name.length <= MAX_SOURCE_LENGTH) return name.trim();
  let end = 0;
  let count = 0;
  for (const point of name) {
    if (count === MAX_SOURCE_LENGTH) break;
    end += point.length;
    count++;
  }
  return name.slice(0, end).trim();
}

/**
 * `rest` without the userinfo of an authority that only a `/`, `?` or `#` ends. A browser ends the authority of a scheme that is
 * neither a web scheme nor `file` there and nowhere else, so its userinfo may hold a `\` (`custom://\user:pw@host`), which
 * urlName otherwise reads as the end of a host (`smb://server\share`). Everything up to the last `@` of that authority goes first.
 */
function afterUserinfo(rest: string): string {
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  return rest.slice(authority.lastIndexOf('@') + 1);
}

/**
 * What a URL names, or null when `given` is not one (no scheme, or a scheme with no authority): its host, or when it has none
 * (`file:///home/ana/BOARD.md`, `https://user:pass@`) the last component of its path, its query and fragment left out.
 *
 * The userinfo (`user:password@`) is never part of the answer, because the authority is parsed rather than matched: it is
 * what follows the scheme's separators up to the first `/`, `\`, `?` or `#`, and its userinfo is everything up to the LAST `@`
 * in it, so a password with an unescaped `@`, an empty host, a port with no host and every spelling of the same URL a browser
 * reads (`https:\\`, `https:///`, `https:/`, `https:`) leave the credentials in neither the host nor the path. (A scheme that is
 * neither a web scheme nor `file` ends it at a `/`, `?` or `#` only, so a `\` can be part of its userinfo: afterUserinfo.) A
 * path is still a path: an `@` in `file:///home/ana/notes@2024.md` is part of a file name. A URL inside a longer text is not
 * recognised here; that is a name like any other, and so is a one-letter scheme (a Windows drive) and
 * `jdbc:postgresql://user:pw@host`, which a browser reads as a path.
 */
function urlName(given: string): string | null {
  const scheme = SCHEME.exec(given);
  if (!scheme) return null;
  let rest = given.slice(scheme[0].length);
  if (WEB_SCHEME.test(scheme[1])) rest = rest.replace(/^[\\/]+/, '');
  else if (/^[\\/]{2}/.test(rest)) rest = /^file$/i.test(scheme[1]) ? rest.slice(2) : afterUserinfo(rest.slice(2));
  else return null;
  const end = rest.search(AUTHORITY_END);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);
  // A bracketed IPv6 host keeps its colons; otherwise the host stops at the port's colon. Always matches (possibly empty).
  const host = /^\[[^\]]*\]|^[^:]*/.exec(hostAndPort)![0];
  if (host.trim() !== '') return host;
  return lastComponent(end === -1 ? '' : rest.slice(end).split(/[?#]/, 1)[0]);
}

/**
 * The name a write stores for the `source` a client sent: a path or a URL reduced to the name it ends in, at most
 * MAX_SOURCE_LENGTH characters, with no control character in it. It may be empty (a source that was only blanks, controls or
 * separators, or a URL that names nothing), which names no one. Never throws on a string.
 */
export function cleanSource(source: string): string {
  // Dropped, not turned into a blank: a URL parser drops a tab or a newline too, so a control character inside the scheme or
  // between its separators (`https:/<tab>/user:pw@host`) must not hide the URL it is in.
  const given = source.replace(CONTROL_CHARACTERS, '').trim();
  const url = urlName(given);
  if (url !== null) return cut(url);
  return cut(SEPARATOR.test(given) ? lastComponent(given) : given);
}

/**
 * The name a daily-note header stores: letters, digits and hyphens, and nothing else, because the header's marks (`+esc`,
 * `, UTC-03:00`) are told apart from a source name by what a name cannot hold (dailyNote.ts). Every run of other characters
 * is written as one hyphen instead of being deleted, none at either end; accents are composed first (a macOS file name is
 * decomposed) and a combining mark that cannot be composed is dropped. It may be empty.
 */
export function headerSource(source: string): string {
  return cleanSource(source)
    .normalize('NFC')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The hive name of a connection, on stdio and on hosted HTTP. It is the daily-note header form, so two
 * spellings a header cannot tell apart are one agent. All transports first use the gateway's shared
 * header-safe reduction, including its stable hash for names with no HTTP-renderable characters.
 * An empty final header form, or the reserved word `unnamed`, is no name.
 */
export function hiveIdentity(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const rendered = headerSource(hiveNameHeader(raw));
  if (rendered === '' || rendered === 'unnamed') return null;
  return rendered;
}

/**
 * The product a client names in its User-Agent: `claude-code/2.1.289 (external, cli)` is `claude-code`. It is the name to
 * give a memory the client saved without saying who it is. Undefined when there is no product with a letter or a digit in it.
 */
export function productFromUserAgent(userAgent: unknown): string | undefined {
  const header = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  if (typeof header !== 'string') return undefined;
  const product = /^\s*([^\s/()]+)/.exec(header)?.[1];
  return product !== undefined && headerSource(product) !== '' ? product : undefined;
}

/**
 * The prefix every imported fact's ledger source carries (importing/plan.ts). A named connection's author is a header
 * name, which has no colon, so a named agent cannot write it; an unnamed client that types it is marked untrusted too,
 * which errs on the side of the warning.
 */
export const IMPORT_SOURCE_PREFIX = 'import:';

/** Whether a stored source names an import (`import:markdown`, `import:renor-index`). */
export function isImportSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && source.startsWith(IMPORT_SOURCE_PREFIX);
}

/**
 * Who saved a fact, as a read shows it. A fact another agent saved names that agent (`source`), and a fact an import saved
 * is `untrusted`: its text came from a file, not from something the user said to an agent. The reader's own facts carry
 * neither, so a reply about them is what it was before. `reader` absent: every named author is another agent.
 */
export interface AuthorMarker {
  source?: string;
  untrusted?: true;
}

export function authorMarker(author: string | null | undefined, reader?: string): AuthorMarker {
  const fromOther = typeof author === 'string' && author !== '' && author !== reader;
  return {
    ...(fromOther ? { source: author } : {}),
    ...(isImportSource(author) ? { untrusted: true as const } : {}),
  };
}
