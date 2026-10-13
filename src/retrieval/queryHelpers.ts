/**
 * Agent-facing query helpers: FTS5 quoting and identity aliases.
 * Keep this free of I/O so tests stay in-process.
 */

/**
 * The workspace owner's names, from RENOR_OWNER_NAMES: a comma-separated list, the first name canonical, every
 * other name an alias of it. Unset means no alias group: no name is built in, so the same name is one identity
 * only by case and Unicode form. Read per call (cheap) so tests and hosted config can change it.
 */
export function ownerNames(): string[] {
  return parsedOwnerNames().slice();
}

// Identity is on the replay hot path (one call per fact), so parse the variable once per value, not per call.
let ownerSource: string | undefined;
let ownerParsed: string[] = [];
function parsedOwnerNames(): string[] {
  const raw = process.env.RENOR_OWNER_NAMES ?? '';
  if (raw !== ownerSource) {
    ownerSource = raw;
    ownerParsed = raw.split(',').map(n => n.trim()).filter(Boolean);
  }
  return ownerParsed;
}

/** The alias groups the identity primitive folds together: the owner's names, when configured. */
function aliasGroups(): string[][] {
  const owner = parsedOwnerNames();
  return owner.length ? [owner] : [];
}

/**
 * Conservative Unicode fold: NFC + plain `toLowerCase()`, marks preserved.
 *
 * Deliberately NOT `normDedupeValue` (context/rowStore.ts), which is NFKD and
 * strips Latin combining marks: that fold merges `José`/`Jose`, `İstanbul`/`Istanbul`
 * and `ﬁle`/`file`, which conflates distinct names. This fold closes only the
 * case axis and the Unicode normalization-form axis (NFC vs NFD), so
 * `José`/`JOSÉ`/NFD-`José` share one identity while `José`/`Jose`,
 * `Αθήνα`/`Αθηνα` (Greek tonos), `Пётр`/`Петр` (ё/е) and `Straße`/`STRASSE` stay
 * distinct. `toLocaleLowerCase('tr')` is never used: it would map `İ`→`i` and
 * collapse a real distinction. Re-normalizing after `toLowerCase()` matters,
 * because lowercasing can decompose (`İ` → `i` + U+0307).
 */
function fold(s: string): string {
  return s.normalize('NFC').trim().toLowerCase().normalize('NFC');
}

/**
 * One identity key for a subject name: the repo's single subject-identity primitive.
 *
 * The import planner and the lifecycle layer must never answer "is this the same
 * subject?" differently, so both call this. It is I/O-free and DB-free, so the
 * planner path stays pure. Explicit aliases collapse to one key
 * (the owner's names from RENOR_OWNER_NAMES); nothing else merges
 * except case and Unicode normalization form.
 *
 * Empty-fold guard: a key that normalizes to nothing (only reachable for an empty /
 * whitespace-only name, since no character is deleted) falls back to the raw name so
 * distinct inputs can never collide on `''`.
 */
export function identityKey(name: string): string {
  const folded = fold(name);
  if (folded === '') return `\u0000raw:${name}`;
  for (const names of aliasGroups()) {
    if (names.some(n => fold(n) === folded)) return fold(names[0]);
  }
  return folded;
}

/** All names that should share one lifecycle identity with `name`. */
export function identityNames(name: string): string[] {
  const key = fold(name);
  for (const names of aliasGroups()) {
    if (names.some(n => fold(n) === key)) {
      const extra = names.includes(name) ? names : [name, ...names];
      return [...new Set(extra)];
    }
  }
  return [name];
}

/**
 * Quote a user string for FTS5 MATCH so hyphens/colons cannot be parsed as
 * operators (`tensaku-capture` must not become `capture` as a column).
 * Empty after trim → empty string (caller should not MATCH).
 */
export function quoteFtsQuery(raw: string): string {
  const q = (raw ?? '').trim();
  if (!q) return '';
  if (q.length > 200) return '';
  const escaped = q.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * A page of a ranked read, cut after its rows have been judged and never before.
 *
 * `read(n)` is the best `n` rows (fewer only when there are no more). `show` judges the rows it is given, each on its
 * own, and returns the ones that are shown, in the order given. Cutting the read at `limit` rows and judging them
 * afterwards lets the rows that are turned away take the places of the ones that are kept: when enough of the best
 * rows are turned away, the page comes up short, or empty, with what belonged on it a little further down. So when the
 * rows read do not fill the page the read is made longer and judged again, until the page is full or every row has been
 * read. The first read is of `first` rows (never fewer than `limit`): a reader that has always read a wider window
 * than its page keeps reading it, so a search whose window holds a full page of rows that are shown, or every row there
 * is, makes that one read of the same rows, as it always did.
 *
 * The rows are judged from the best, a few at a time, and no row below the one that fills the page is judged: the page
 * is the first `limit` rows that are shown, and `show` judges each row on its own, so judging a prefix is judging the
 * whole read, as far as the page goes. A keyword search reads a window of 60 rows to show 6: the other 54 were judged
 * for nothing.
 */
export function shownPage<R, T>(read: (rows: number) => R[], show: (rows: R[]) => T[], limit: number, first = limit): T[] {
  if (!(limit > 0)) return [];
  const batch = Math.max(limit, 8);
  for (let rows = first > limit ? first : limit; ; rows *= 4) {
    const ranked = read(rows);
    const shown: T[] = [];
    for (let at = 0; at < ranked.length && shown.length < limit; at += batch) shown.push(...show(ranked.slice(at, at + batch)));
    if (shown.length >= limit || ranked.length < rows) return shown.slice(0, limit);
  }
}

export function pickTopK(args: { topK?: unknown; top_k?: unknown }, fallback = 20, max = 100): number {
  const raw = args.topK ?? args.top_k ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

export function pickEntityName(args: { entityName?: unknown; name?: unknown; subject?: unknown }): string {
  const v = args.entityName ?? args.name ?? args.subject;
  return typeof v === 'string' ? v.trim() : '';
}
