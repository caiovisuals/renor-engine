import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { hiveIdentity } from './sourceName';

/**
 * One live stdio process may hold a hive name. The lease is a row in the workspace database, so a second
 * process sharing that file sees it. The holder is `${pid}:${nonce}`. A dead pid is stolen; a live pid is not.
 * Closing the MCP client does not release it: the process is still that name until it exits.
 */
export function claimAgentLease(db: Database.Database, agent: string, holder: string, now: Date = new Date()): void {
  const identity = hiveIdentity(agent);
  if (!identity) {
    throw new Error('a hive lease needs a name that contains a letter or a digit, other than unnamed');
  }
  const existing = db.prepare('SELECT holder FROM agent_leases WHERE agent = ?').get(identity) as { holder: string } | undefined;
  if (existing && existing.holder !== holder && pidAlive(existing.holder)) {
    throw new Error(
      `another live connection is named ${JSON.stringify(identity)}; set RENOR_CONNECTION_NAME to a different name, or stop the other renor-engine mcp process, then reconnect`,
    );
  }
  db.prepare(
    `INSERT INTO agent_leases (agent, holder, seen_at) VALUES (?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET holder = excluded.holder, seen_at = excluded.seen_at`,
  ).run(identity, holder, now.toISOString());
}

/** A new holder for this process. Two calls are two connections, even in one process. */
export function newLeaseHolder(): string {
  return `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
}

function pidAlive(holder: string): boolean {
  const pid = Number(holder.split(':')[0]);
  // pid 0 is the process group. Never signal it.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
