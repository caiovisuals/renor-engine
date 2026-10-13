import fs from 'fs';
import { openReadOnlyDb } from '../db/client';
import { parseLedgerEvents } from '../memory/lifecycle';
import { streamKey } from './plan';

/**
 * Fact streams a destination already represents.
 *
 * Two sources, because they disagree in a way that matters: the **ledger** is canonical
 * and the index is derived. A stream a ledger event already declares is represented even
 * when the projection has not caught up — and importing an older value for it would not
 * merely duplicate, it would fail the engine's per-stream monotonicity check during
 * replay, which runs at service STARTUP and refuses to serve. Skipping it is the only
 * safe move, and the skip is counted and reported rather than silent.
 */
export function readExistingStreams(dbPath: string, ledgerPath: string): Set<string> {
  const streams = new Set<string>();

  let db: ReturnType<typeof openReadOnlyDb> | null = null;
  try {
    db = openReadOnlyDb(dbPath);
    const rows = db.prepare(
      `SELECT e.canonical_name AS subject, f.predicate AS predicate, f.scope AS scope
         FROM facts f JOIN entities e ON e.id = f.subject_entity_id
        WHERE f.valid_to IS NULL AND f.source_path = '_mcp_'`,
    ).all() as Array<{ subject: string; predicate: string; scope: string | null }>;
    for (const row of rows) streams.add(streamKey(row.subject, row.predicate, row.scope ?? 'global'));
  } catch {
    // A destination with no index yet simply has no indexed streams.
  } finally {
    db?.close();
  }

  try {
    const content = fs.readFileSync(ledgerPath, 'utf8');
    for (const event of parseLedgerEvents(content)) {
      streams.add(streamKey(event.subject, event.predicate, event.scope ?? 'global'));
    }
  } catch {
    // No ledger yet, or an unreadable one: nothing declared that this read can vouch for.
    // Replay still fails closed on the real content, so this cannot launder a bad ledger.
  }

  return streams;
}
