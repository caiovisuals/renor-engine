import crypto from 'crypto';
import type Database from '../db/sqlite';
import { normalizeScope, savedScopeSqlPredicate } from '../mvp/scope';
import { assertNoUnstorableControls } from './controls';
import { hiveIdentity } from './sourceName';

/**
 * A request is a record only. Asking, answering or closing one never runs a tool,
 * writes a memory, or wakes another agent. The addressee still acts only under its own rules.
 */
export interface AgentRequest {
  id: string;
  scope: string | null;
  from_agent: string;
  to_agent: string;
  question: string;
  answer: string | null;
  status: 'open' | 'answered' | 'closed';
  created_at: string;
  answered_at: string | null;
  closed_at: string | null;
}

const STATUSES = new Set(['open', 'answered', 'closed']);

/** How many requests one sending connection may record per rolling hour, unless RENOR_ASK_AGENT_PER_HOUR says otherwise. */
export const DEFAULT_ASK_AGENT_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/** The hourly limit for ask_agent: RENOR_ASK_AGENT_PER_HOUR when it is a positive integer, otherwise the default. */
export function askAgentPerHour(): number {
  const raw = Number(process.env.RENOR_ASK_AGENT_PER_HOUR);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_ASK_AGENT_PER_HOUR;
}

/** Records a connection name the gateway set (x-renor-agent), so ask_agent can address it. "unnamed" is never recorded. */
export function noteKnownAgent(db: Database.Database, agent: string, now: Date = new Date()): void {
  if (agent === 'unnamed') return;
  db.prepare('INSERT OR IGNORE INTO known_agents (agent, first_seen) VALUES (?, ?)').run(agent, now.toISOString());
}

function isKnownAgent(db: Database.Database, agent: string): boolean {
  return db.prepare('SELECT 1 FROM known_agents WHERE agent = ?').get(agent) !== undefined;
}

function row(db: Database.Database, id: string): AgentRequest {
  const found = db.prepare('SELECT * FROM agent_requests WHERE id = ?').get(id) as AgentRequest | undefined;
  if (!found) throw new Error('no request with that id');
  return found;
}

export function askAgent(db: Database.Database, args: {
  from: string;
  to: string;
  request: string;
  scope?: string;
  now?: Date;
  /** Only a connection name this workspace has seen can be addressed; never "unnamed". The MCP tool sets it. */
  knownOnly?: boolean;
  /** At most this many requests from this sender in the last hour. The MCP tool sets it. */
  perHour?: number;
}): { id: string; status: 'open'; from_agent: string; to_agent: string; created_at: string } {
  const rawTo = args.to.trim();
  const question = args.request.trim();
  if (!rawTo) throw new Error('ask_agent needs who it is for');
  if (!question) throw new Error('ask_agent needs a request');
  // Store the header form, the same name stdio and hosted publish. A spelling a header cannot render is unnamed.
  const to = hiveIdentity(rawTo);
  const from = hiveIdentity(args.from);
  if (!from) throw new Error('ask_agent needs a connection name');
  if (!to) throw new Error('ask_agent cannot address unnamed: that is every connection whose key has no name. Name the key, then ask it by that name');
  // A request is text another agent reads, so it is held to the same rule as a memory: no control
  // character a reader cannot see (memory/controls.ts). Checked before anything is stored.
  assertNoUnstorableControls('ask_agent to', to);
  assertNoUnstorableControls('ask_agent request', question);
  const now = args.now ?? new Date();
  if (args.knownOnly) {
    if (!isKnownAgent(db, to)) throw new Error(`no connection named ${JSON.stringify(to)} has connected to this workspace; ask_agent addresses an agent by the name on its connection key`);
  }
  if (args.perHour !== undefined) {
    const since = new Date(now.getTime() - HOUR_MS).toISOString();
    const recent = db.prepare(
      'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM agent_requests WHERE from_agent = ? AND created_at > ?',
    ).get(from, since) as { n: number; oldest: string | null };
    if (recent.n >= args.perHour) {
      const retry = new Date(Date.parse(recent.oldest!) + HOUR_MS).toISOString();
      throw new Error(`ask_agent is limited to ${args.perHour} requests per hour per connection; this one can ask again after ${retry}`);
    }
  }
  const id = `req_${crypto.randomBytes(8).toString('hex')}`;
  const created = now.toISOString();
  db.prepare(
    `INSERT INTO agent_requests (id, scope, from_agent, to_agent, question, answer, status, created_at, answered_at, closed_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'open', ?, NULL, NULL)`,
  ).run(id, args.scope !== undefined && args.scope.trim() !== '' ? normalizeScope(args.scope) : null, from, to, question, created);
  return { id, status: 'open', from_agent: from, to_agent: to, created_at: created };
}

/** At most this many requests one list returns, the newest; the rest are counted. whats_new leads with the same number. */
export const REQUEST_PAGE_LIMIT = 20;

interface ListArgs {
  agent: string;
  status?: string;
  to?: string;
  scope?: string;
  /** Only requests older than this one (a request id from whats_new or list_requests): the next page. */
  before?: string;
}

function listWhere(args: ListArgs): { sql: string; params: string[]; caller: string } {
  const status = args.status ?? 'open';
  if (!STATUSES.has(status)) throw new Error('list_requests status must be open, answered or closed');
  const caller = hiveIdentity(args.agent) ?? args.agent.trim();
  let sql: string;
  const params: string[] = [];
  if (args.to !== undefined && args.to.trim() !== '') {
    // `to` names the other party of a thread, not an inbox to read. Both directions count: the request
    // this connection asked of that agent, and the request that agent asked of this one. A connection
    // that is neither party to a thread cannot list it, and cannot page through it.
    const other = hiveIdentity(args.to);
    if (!other) throw new Error('list_requests cannot address unnamed: that is every connection whose key has no name. Name the key, then ask it by that name');
    sql = 'status = ? AND ((from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?))';
    params.push(status, caller, other, other, caller);
  } else {
    // With no `to` this is the caller's own inbox, exactly as it has always been.
    sql = 'status = ? AND to_agent = ?';
    params.push(status, caller);
  }
  let scopeSql = '';
  if (args.scope !== undefined && args.scope.trim() !== '') {
    // Every spelling of the scope (atlas, scope:atlas, project:atlas); a request asked with no scope is global.
    const saved = savedScopeSqlPredicate(normalizeScope(args.scope), "COALESCE(scope, 'global')");
    scopeSql = ` AND ${saved.sql}`;
    params.push(...saved.params);
  }
  return { sql: `${sql}${scopeSql}`, params, caller };
}

/** An answer is for the agent who asked and the one who answered; anyone else sees that it was answered, not what. */
function visibleTo(agent: string, r: AgentRequest): AgentRequest {
  return r.from_agent === agent || r.to_agent === agent ? r : { ...r, answer: null };
}

/** Every request matching `args`, newest first. Unbounded: the tools read `listRequestsPage`. */
export function listRequests(db: Database.Database, args: ListArgs): AgentRequest[] {
  const where = listWhere(args);
  const rows = db.prepare(
    `SELECT * FROM agent_requests WHERE ${where.sql} ORDER BY created_at DESC, rowid DESC`,
  ).all(...where.params) as AgentRequest[];
  return rows.map((r) => visibleTo(args.agent, r));
}

export interface RequestPage {
  requests: AgentRequest[];
  /** How many more match, older than the last one listed. Absent when none. */
  more_requests?: number;
  /** Set with more_requests: how to reach them ("N older requests not shown; use list_requests with before=<id>"). */
  more_requests_hint?: string;
}

/**
 * The newest REQUEST_PAGE_LIMIT requests matching `args` (older than `args.before` when given), and how many more there
 * are (`more_requests`, absent when none) with the call that lists them (`more_requests_hint`). What list_requests and
 * whats_new return: a flood of requests costs a reader one bounded page, never all of it.
 */
export function listRequestsPage(db: Database.Database, args: ListArgs): RequestPage {
  const where = listWhere(args);
  let sql = where.sql;
  const params: Array<string | number> = [...where.params];
  if (args.before !== undefined && args.before.trim() !== '') {
    // Same order as the list (created_at, then insertion): strictly after the given request in it.
    // The anchor has to be a request this caller is a party to. Another pair's id is not a page cursor.
    const anchor = db.prepare(
      'SELECT created_at, rowid AS rid FROM agent_requests WHERE id = ? AND (from_agent = ? OR to_agent = ?)',
    ).get(args.before.trim(), where.caller, where.caller) as { created_at: string; rid: number } | undefined;
    if (!anchor) throw new Error('list_requests before must be the id of a request from whats_new or list_requests');
    sql += ' AND (created_at < ? OR (created_at = ? AND rowid < ?))';
    params.push(anchor.created_at, anchor.created_at, anchor.rid);
  }
  const rows = db.prepare(
    `SELECT * FROM agent_requests WHERE ${sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(...params, REQUEST_PAGE_LIMIT) as AgentRequest[];
  const requests = rows.map((r) => visibleTo(args.agent, r));
  if (requests.length < REQUEST_PAGE_LIMIT) return { requests };
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM agent_requests WHERE ${sql}`).get(...params) as { n: number }).n;
  if (total <= requests.length) return { requests };
  const more = total - requests.length;
  const last = requests[requests.length - 1].id;
  return {
    requests,
    more_requests: more,
    more_requests_hint: `${more} older request${more === 1 ? '' : 's'} not shown; use list_requests with before=${last}`,
  };
}

export function answerRequest(db: Database.Database, args: {
  agent: string;
  id: string;
  answer: string;
  now?: Date;
}): AgentRequest {
  const found = row(db, args.id);
  if (found.to_agent !== args.agent) throw new Error('only the agent this request is for can answer it');
  if (found.status === 'closed') throw new Error('a closed request cannot be answered');
  const answer = args.answer.trim();
  if (!answer) throw new Error('answer_request needs an answer');
  // The same rule ask_agent holds to: an answer is text another agent reads back (memory/controls.ts).
  assertNoUnstorableControls('answer_request answer', answer);
  const at = (args.now ?? new Date()).toISOString();
  // The guard is in the statement too: a close on another handle between the read above and this write must win.
  const changed = db.prepare(
    `UPDATE agent_requests SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status != 'closed'`,
  ).run(answer, at, args.id).changes;
  if (changed === 0) throw new Error('a closed request cannot be answered');
  return row(db, args.id);
}

export function closeRequest(db: Database.Database, args: {
  agent: string;
  id: string;
  now?: Date;
}): AgentRequest {
  const found = row(db, args.id);
  if (found.to_agent !== args.agent && found.from_agent !== args.agent) {
    throw new Error('only the agent this request is for, or the one who asked, can close it');
  }
  if (found.status === 'closed') return found;
  const at = (args.now ?? new Date()).toISOString();
  db.prepare(`UPDATE agent_requests SET status = 'closed', closed_at = ? WHERE id = ?`).run(at, args.id);
  return row(db, args.id);
}
