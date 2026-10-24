import { factText } from '../retrieval/ledgerPresentation';

/**
 * get_context without repeats (RENOR_CONTEXT_DISTINCT, off by default: the reply is then what it always was).
 *
 * A first-week study of live replies found about 60% of the "memories" were records of the ledger and 64% of those said
 * what the same reply already said. The budget counts every one of them, so a repeat is room a distinct memory did not
 * get. A memory is a repeat when it adds nothing the reply holds elsewhere:
 *  - a ledger record whose text is a fact the reply lists (`subject — predicate: object`) under another event;
 *  - a memory whose words another memory holds whole (the same statement from the ledger and a daily note, or one chunk
 *    inside a longer one); the first-listed, i.e. higher-ranked, copy stays, and when one holds the other the longer stays.
 * A memory that carries a marker (a correction, untrusted, an import, "matched: false") is never dropped: the marker is
 * information the copy does not have.
 */
export const CONTEXT_DISTINCT_FLAG = 'RENOR_CONTEXT_DISTINCT';

export function contextDistinctEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CONTEXT_DISTINCT_FLAG] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Shorter than this, a text is too little to say another one holds it ("Yes", a bare name). */
const MIN_CHARS = 20;

const DAILY_PREFIX = /^(?:\s*-\s*\[[^\]]*\]\s*(?:\([^)]*\)\s*)?)+/;
const MARKERS = ['replaced', 'untrusted', 'origin', 'matched'] as const;

/** A text as its words alone, without a daily-log entry's time and writer. */
function words(text: string): string {
  return text.replace(DAILY_PREFIX, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export interface DistinctMemory { notePath: string; text: string }
export interface DistinctFact { subject: string; predicate: string; object?: string | null }

/** `memories` without the repeats, in their order. `isLedger` tells a record of the ledger by its note path. */
export function distinctMemories<T extends DistinctMemory>(
  memories: readonly T[],
  facts: readonly DistinctFact[],
  isLedger: (notePath: string) => boolean,
): T[] {
  const stated = facts.map(f => words(factText(f.subject, f.predicate, f.object ?? undefined))).filter(s => s.length >= MIN_CHARS);
  const texts = memories.map(m => words(m.text));
  const dropped = new Set<number>();
  memories.forEach((memory, i) => {
    if (MARKERS.some(key => key in memory)) return;
    const mine = texts[i];
    if (mine.length < MIN_CHARS) return;
    if (isLedger(memory.notePath) && stated.some(s => mine === s)) { dropped.add(i); return; }
    const held = texts.some((other, j) => j !== i && !dropped.has(j) && other.length >= mine.length
      && (other === mine ? j < i : ` ${other} `.includes(` ${mine} `)));
    if (held) dropped.add(i);
  });
  return dropped.size === 0 ? [...memories] : memories.filter((_, i) => !dropped.has(i));
}
