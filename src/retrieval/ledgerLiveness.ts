import Database from '../db/sqlite';
import { readUntilWrite, tableHasColumns } from '../db/readCache';
import { prepareOnce } from '../db/statements';

/* Liveness comes only from the ledger's closed_event links. History is an explicit
 * caller option (include_history), never inferred from the wording of a query. */

/** The closed ledger events (lower-case ids), and among them the ones a read never shows. */
export interface ClosedLedgerEvents extends ReadonlySet<string> {
  /**
   * Shown not even as history: a retired fact's event, and every retire and restore event (memory/lifecycle.ts). The
   * retired value must leave every read, and the retire events are the engine's bookkeeping of that, not something the
   * user said.
   */
  readonly hidden: ReadonlySet<string>;
}

/**
 * The lifecycle projection is updated on write, independently of the chunk
 * index. Resolve event identity here rather than comparing object strings:
 * A -> B -> A still closes the first A, and unindexed corrections take effect.
 */
export function closedLedgerEvents(db: Database.Database): ClosedLedgerEvents {
  if (!tableHasColumns(db, 'facts', ['event_id'])) return Object.assign(new Set<string>(), { hidden: new Set<string>() });
  // One read serves every ask until a fact is written: a search asks several times (each lane, each page of a read).
  return readUntilWrite(db, 'closedLedgerEvents', () => {
    const rows = prepareOnce(db, `SELECT event_id FROM facts
      WHERE source_path = '_mcp_' AND event_id IS NOT NULL AND valid_to IS NOT NULL`).all() as Array<{ event_id: string }>;
    const hidden = tableHasColumns(db, 'retired_facts', ['event_id']) && tableHasColumns(db, 'fact_retirements', ['event_id'])
      ? (prepareOnce(db, 'SELECT event_id FROM retired_facts UNION SELECT event_id FROM fact_retirements').all() as Array<{ event_id: string }>)
      : [];
    const hiddenIds = new Set(hidden.map(r => r.event_id.toLowerCase()));
    return Object.assign(new Set([...rows.map(r => r.event_id.toLowerCase()), ...hiddenIds]), { hidden: hiddenIds });
  });
}

/**
 * The ledger events (lower-case ids) a hit carries: the ids on its `## MEM_… · ` headers or, for a chunk cut
 * below its header, the id in its heading path. Empty for anything that is not a ledger event.
 */
export function ledgerEventIds(hit: { text: string; headingPath?: string }): string[] {
  // A text without `mem_` has no `## MEM_… · ` header (NAMES_AN_EVENT, below): most hits, asked about several times each.
  const ids = NAMES_AN_EVENT.test(hit.text) ? [...hit.text.matchAll(/^## (MEM_[A-Za-z0-9]+) · /gim)].map(m => m[1].toLowerCase()) : [];
  if (ids.length) return ids;
  const fromHeading = hit.headingPath?.match(/\b(MEM_[A-Za-z0-9]+)\b/i)?.[1];
  return fromHeading ? [fromHeading.toLowerCase()] : [];
}

/** Whether a text can name a ledger event at all: every pattern that reads an event id below starts with `MEM_`, in either case. */
const NAMES_AN_EVENT = /mem_/i;

/** The line that opens a superseded event shown on request (include_history). */
export const SUPERSEDED_LABEL = '[Superseded memory event; historical evidence only]';

/**
 * Also handles legacy/large chunks containing several ledger event blocks. An event in `closed.hidden`
 * (closedLedgerEvents) is dropped even with includeHistory.
 */
export function resolveLedgerHits<T extends { text: string; headingPath?: string; reason: string }>(
  hits: T[], closed: ReadonlySet<string> & { readonly hidden?: ReadonlySet<string> }, includeHistory: boolean,
): T[] {
  if (!closed.size) return hits;
  const hidden = closed.hidden;
  return hits.flatMap(hit => {
    // An event is named by `## MEM_… · ` in the text or by `MEM_…` in the heading path, in either case. A hit with
    // neither holds no block to close, so it comes back as it is, without the split and the matches below.
    if (!NAMES_AN_EVENT.test(hit.text) && !(hit.headingPath && NAMES_AN_EVENT.test(hit.headingPath))) return [hit];
    let superseded = false;
    let dropped = false;
    const blocks = hit.text.replace(/\r\n/g, '\n').split(/(?=^## MEM_[A-Za-z0-9]+ · )/im);
    const kept = blocks.flatMap(block => {
      const id = block.match(/^## (MEM_[A-Za-z0-9]+) · /im)?.[1]
        ?? (blocks.length === 1 ? hit.headingPath?.match(/\b(MEM_[A-Za-z0-9]+)\b/i)?.[1] : undefined);
      const isClosed = !!id && closed.has(id.toLowerCase());
      if (!isClosed) return [block];
      if (hidden?.has(id!.toLowerCase())) {
        dropped = true;
        return [];
      }
      superseded = true;
      return includeHistory ? [`${SUPERSEDED_LABEL}\n${block}`] : [];
    });
    if (!superseded && !dropped) return [hit];
    const text = kept.join('').trim();
    const history = includeHistory && superseded;
    if (!text || (!history && !kept.some(b => /^## MEM_/im.test(b)))) return [];
    return [{ ...hit, text,
      ...(!history ? { headingPath: text.match(/^## (MEM_[A-Za-z0-9]+ · .+)$/im)?.[1] ?? hit.headingPath } : {}),
      reason: history ? `${hit.reason}+superseded` : hit.reason }];
  });
}
