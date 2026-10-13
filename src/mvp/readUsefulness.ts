import { createHmac, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ledgerEventIds } from '../retrieval/ledgerLiveness';
import { emitTelemetry, type TelemetryEvent } from './telemetry';

/**
 * Whether a read helped, measured by the engine alone: nothing is asked of the user or the agent.
 *
 * SERVED. Every get_context, search_memory and retrieve_memory reply that succeeded emits one metadata-only `read` event:
 * the tool, whether the reply held something relevant, how many items it returned, and a short opaque id for each. The
 * engine's own verdict (`relevance.relevant`) is the answer where the reply has one (`judged: true`); a reply with none
 * (relevance not armed, a lookup by subject) counts as relevant when it returned anything (`judged: false`).
 *
 * USED. A returned item counts as used when, in this workspace and within the window, the agent
 *   - reads it in full (read_memory of the same note),
 *   - names it in the optional `cites` argument of a save (a notePath, a memory id or a fact's subject a read returned), or
 *   - saves a new value for the same subject and predicate (a correction or an update).
 * The inference runs here, from what this process served; only the counts leave it, as one `read_used` event per read the
 * first time one of its items is used. A read that served nothing relevant is not tracked: its items are only the nearest
 * ones, so a later save about them says nothing about the read.
 *
 * Opaque by construction: the ids are keyed hashes under a secret made when the process starts, so they say nothing about
 * what an item is and cannot be matched to a note or a fact by anyone who lacks it. They are stable within one run of the
 * engine, not across restarts. There is one tracker per engine process, and an engine serves one workspace, so an item
 * served to one workspace can never be used by another. Nothing here is written to disk: a restart forgets what it served,
 * which can only lose a use, never invent one.
 *
 * NEVER put memory text, a query, a path or a name into an event.
 */

export type ReadTool = 'get_context' | 'search_memory' | 'retrieve_memory';
export type UseVia = 'read' | 'cite' | 'update';

/** How long after a read a use still counts. Long enough for a multi-step task, short enough to stay one working session. */
export const DEFAULT_USE_WINDOW_MINUTES = 30;
const MAX_WINDOW_MINUTES = 240;
/** Reads kept to be matched, so a busy workspace cannot grow the tracker without bound. */
const MAX_TRACKED_READS = 300;
/** Ids an event lists; `items` still counts them all. */
const MAX_EVENT_IDS = 20;

export interface ServedItem {
  /** What the item is: `note:<path>`, `fact:<subject>\0<predicate>` or `text:<text>` (identity only, never emitted). */
  key: string;
  /** Other names a `cites` entry may use for it. */
  handles?: string[];
}

interface TrackedRead {
  id: string;
  tool: ReadTool;
  at: number;
  keys: Set<string>;
  handles: Set<string>;
  used: boolean;
}

const norm = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function noteItem(notePath: string): ServedItem {
  return { key: `note:${notePath}` };
}

export function factItem(subject: string, predicate: string): ServedItem {
  return { key: `fact:${norm(subject)}\0${norm(predicate)}`, handles: [`subject:${norm(subject)}`] };
}

/** The note a memory id names (`note:<path>`, `entry:<path>#<hash>`), or the text itself when it names none. */
function noteOfId(id: string): string {
  if (id.startsWith('note:')) return id.slice(5);
  if (id.startsWith('entry:')) {
    const hashAt = id.lastIndexOf('#');
    return hashAt > 6 ? id.slice(6, hashAt) : id.slice(6);
  }
  return id;
}

function windowMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number((env.RENOR_READ_USE_WINDOW_MINUTES ?? '').trim());
  const minutes = Number.isFinite(parsed) && parsed >= 1 ? Math.min(MAX_WINDOW_MINUTES, Math.trunc(parsed)) : DEFAULT_USE_WINDOW_MINUTES;
  return minutes * 60_000;
}

export class ReadUsefulness {
  private readonly reads: TrackedRead[] = [];
  private readonly secret = randomBytes(32);
  private readonly windowMs: number;

  constructor(
    private readonly emit: (event: TelemetryEvent) => void = emitTelemetry,
    private readonly now: () => number = Date.now,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.windowMs = windowMs(env);
  }

  private opaque(key: string): string {
    return createHmac('sha256', this.secret).update(key).digest('hex').slice(0, 8);
  }

  /** Builds what a reply served and records it. Building reads the database, so it is inside the guard too. */
  measure(tool: ReadTool, build: () => { items: ServedItem[]; relevant: boolean; judged: boolean }): void {
    try {
      const served = build();
      this.served(tool, served.items, served.relevant, served.judged);
    } catch {
      // Measuring must never break a read.
    }
  }

  /** A reply was served. `items` are its returned items; `relevant` and `judged` as described above. */
  served(tool: ReadTool, items: ServedItem[], relevant: boolean, judged: boolean): void {
    try {
      const at = this.now();
      const unique = new Map<string, ServedItem>();
      for (const item of items) if (!unique.has(item.key)) unique.set(item.key, item);
      const id = randomBytes(4).toString('hex');
      this.emit({
        event: 'read',
        tool,
        read: id,
        relevant,
        judged,
        items: unique.size,
        ids: [...unique.keys()].slice(0, MAX_EVENT_IDS).map(key => this.opaque(key)),
      });
      if (!relevant || unique.size === 0) return;
      this.prune(at);
      this.reads.push({
        id,
        tool,
        at,
        keys: new Set(unique.keys()),
        handles: new Set([...unique.values()].flatMap(item => item.handles ?? [])),
        used: false,
      });
      if (this.reads.length > MAX_TRACKED_READS) this.reads.splice(0, this.reads.length - MAX_TRACKED_READS);
    } catch {
      // Measuring must never break a read.
    }
  }

  /** The agent read one memory in full (read_memory). */
  readInFull(memoryId: string): void {
    this.use('read', read => read.keys.has(`note:${noteOfId(memoryId)}`));
  }

  /** A save named what it builds on. Each cite is a notePath or memory id a read returned, or a fact's subject. */
  cited(cites: readonly string[] | undefined): void {
    if (!cites?.length) return;
    const wanted = cites.slice(0, 20).map(cite => cite.trim()).filter(Boolean);
    this.use('cite', read => wanted.some(cite => read.keys.has(`note:${noteOfId(cite)}`) || read.handles.has(`subject:${norm(cite)}`)));
  }

  /** A fact was saved with a new value for a subject and predicate (a correction or an update). */
  updated(subject: string, predicate: string): void {
    const key = factItem(subject, predicate).key;
    this.use('update', read => read.keys.has(key));
  }

  private use(via: UseVia, matches: (read: TrackedRead) => boolean): void {
    try {
      const at = this.now();
      this.prune(at);
      for (const read of this.reads) {
        if (read.used || !matches(read)) continue;
        read.used = true;
        this.emit({
          event: 'read_used',
          tool: read.tool,
          read: read.id,
          via,
          after_s: Math.max(0, Math.round((at - read.at) / 1000)),
        });
      }
    } catch {
      // Measuring must never break a save.
    }
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    let drop = 0;
    while (drop < this.reads.length && this.reads[drop].at < cutoff) drop++;
    if (drop > 0) this.reads.splice(0, drop);
  }
}

// ---- What each tool's reply serves ---------------------------------------------------------------------------------

/** get_context: its facts by subject and predicate, its memories by note. A memory of a saved fact names no note. */
export function contextItems(body: Record<string, unknown>): { items: ServedItem[]; relevant: boolean; judged: boolean } {
  const items: ServedItem[] = [];
  for (const fact of Array.isArray(body.facts) ? body.facts as Array<Record<string, unknown>> : []) {
    if (typeof fact.subject === 'string' && typeof fact.predicate === 'string') items.push(factItem(fact.subject, fact.predicate));
  }
  for (const memory of Array.isArray(body.memories) ? body.memories as Array<Record<string, unknown>> : []) {
    if (typeof memory.notePath === 'string' && memory.notePath !== '') items.push(noteItem(memory.notePath));
    else if (typeof memory.text === 'string') items.push({ key: `text:${memory.text}` });
  }
  return verdictOf(body.relevance, items);
}

function verdictOf(relevance: unknown, items: ServedItem[]): { items: ServedItem[]; relevant: boolean; judged: boolean } {
  const judged = typeof relevance === 'object' && relevance !== null && typeof (relevance as { relevant?: unknown }).relevant === 'boolean';
  return { items, relevant: judged ? (relevance as { relevant: boolean }).relevant : items.length > 0, judged };
}

/**
 * search_memory: its hits as they are before the ledger's markup is taken off, so a fact is named by what it claims. A hit
 * of the ledger names the facts of its events (the facts table knows each event's subject and predicate); anything else is
 * a note.
 */
export function searchItems(
  db: Database.Database,
  isLedger: (notePath: string) => boolean,
  hits: ReadonlyArray<{ notePath: string; headingPath?: string; text: string }>,
  relevance: unknown,
): { items: ServedItem[]; relevant: boolean; judged: boolean } {
  const events = new Set<string>();
  for (const hit of hits) if (isLedger(hit.notePath)) for (const id of ledgerEventIds(hit)) events.add(id);
  const named = new Map<string, { subject: string; predicate: string }>();
  if (events.size > 0) {
    const ids = [...events];
    const rows = db.prepare(
      `SELECT lower(f.event_id) AS event, e.canonical_name AS subject, f.predicate AS predicate
       FROM facts f JOIN entities e ON e.id = f.subject_entity_id
       WHERE lower(f.event_id) IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids) as Array<{ event: string; subject: string; predicate: string }>;
    for (const row of rows) named.set(row.event, row);
  }
  const items: ServedItem[] = [];
  for (const hit of hits) {
    if (!isLedger(hit.notePath)) {
      items.push(hit.notePath ? noteItem(hit.notePath) : { key: `text:${hit.text}` });
      continue;
    }
    const facts = ledgerEventIds(hit).map(id => named.get(id)).filter((fact): fact is { subject: string; predicate: string } => fact !== undefined);
    if (facts.length > 0) { for (const fact of facts) items.push(factItem(fact.subject, fact.predicate)); continue; }
    // A fact the index has not caught up with is headed `subject > predicate`.
    const [subject, predicate] = (hit.headingPath ?? '').split(' > ');
    items.push(subject && predicate ? factItem(subject, predicate) : { key: `text:${hit.text}` });
  }
  return verdictOf(relevance, items);
}

/** retrieve_memory: the facts of the subject it was asked for, by the subject the facts table names them under. */
export function retrieveItems(
  db: Database.Database,
  facts: ReadonlyArray<{ subject_entity_id?: number; predicate: string }>,
): { items: ServedItem[]; relevant: boolean; judged: boolean } {
  const ids = [...new Set(facts.map(f => f.subject_entity_id).filter((id): id is number => typeof id === 'number'))];
  const names = new Map<number, string>();
  if (ids.length > 0) {
    const rows = db.prepare(`SELECT id, canonical_name AS name FROM entities WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: number; name: string }>;
    for (const row of rows) names.set(row.id, row.name);
  }
  const items = facts.flatMap(f => {
    const subject = f.subject_entity_id === undefined ? undefined : names.get(f.subject_entity_id);
    return subject === undefined ? [] : [factItem(subject, f.predicate)];
  });
  return { items, relevant: items.length > 0, judged: false };
}
