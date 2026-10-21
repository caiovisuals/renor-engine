/**
 * Context700 campaign — MUTABLE context compiler.
 *
 * Campaign contract (docs/agents/autoresearch/context700/program.md):
 * - Target: <= 700 mean Renor memory-evidence tokens/query on LongMemEval-S full-500.
 * - Frozen quality floor: >= 428/500, no category regression > 2.0 pp vs N22 (430/500).
 * - ONLY this file is mutable after harness freeze.
 *
 * The compiler is gold-blind: it may use the question text/date, retrieval hits,
 * and structured extraction tables. It may NOT use gold answers, benchmark
 * question IDs (as decision keys), judge outputs, or correctness labels.
 *
 * v3 (structured-first + date-preserving compaction + recency raw fill):
 *   Lesson from v1 (31/118 screen KILL): raw-first 55% budget + aggressive
 *   compaction starved date-bearing stubs and chronicle breadth. v3:
 *   1. Query-gated structured rows FIRST (facts cap 12, chronicle cap 10, prefs cap 6).
 *   2. Raw excerpts: compact turn markers, PRESERVE Timestamp/date lines and
 *      header stubs (they carry session dates), recency-ordered like N22.
 *   3. Fill remaining budget by rank; no minimum raw count (tables win ties).
 */
import { countTextTokens } from './textTokens';

export interface CompilerHit {
  text: string | null;
  notePath: string;
  score: number;
}

export interface CompilerFactRow {
  value: number | string;
  unit?: string;
  verb?: string;
  object?: string;
  event?: string;
  coexist?: string;
}

export interface CompilerChronRow {
  when?: string;
  event?: string;
  entities?: string;
}

export interface CompilerPrefRow {
  statement?: string;
  kind?: string;
}

export interface CompilerQuestion {
  id: string;
  category: string;
  query: string;
  questionDate: string;
  question: string;
  shouldAbstain: boolean;
}

export interface CompilerTables {
  facts?: CompilerFactRow[];
  chronicle?: CompilerChronRow[];
  prefs?: CompilerPrefRow[];
}

export type DateMap = Map<string, string>;

export interface CompiledContext {
  context: string;
  tokens: number;
  parts: {
    rawTokens: number;
    factsTokens: number;
    chronicleTokens: number;
    prefsTokens: number;
  };
  diagnostics?: Record<string, unknown>;
}

const canonicalSegment = (notePath: string): string =>
  notePath.replace(/^Sessions\//, '').replace(/-occ\d+\.md$/, '.md').replace(/\.md$/, '');

export const isHeaderOnly = (text: string): boolean =>
  !text.includes('### Turn') && text.trim().length < 250;

export const COMPILER_VERSION = 'v3-struct-first-date-keeping';

const CONTENT_STOP = new Set(
  'the a an of to for and or in on my i with is are was be that this it at as by from have has had do does did not no you your me we our they their he she his her about into over under then than so if but'.split(' '),
);

const contentWords = (s: string): Set<string> => {
  const out = new Set<string>();
  for (const w of s.toLowerCase().matchAll(/[a-z0-9]{3,}/g)) {
    if (!CONTENT_STOP.has(w[0])) out.add(w[0]);
  }
  return out;
};

/** Compact date: "2023/05/30 (Tue) 23:40" -> "2023/05/30". */
const compactDate = (d: string | null): string =>
  d ? d.replace(/\s*\((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\).*/, '') : '';

/**
 * v3 compaction: shorten turn markers to `[N-role]`, drop long session headers,
 * but PRESERVE Timestamp lines (dates are load-bearing for temporal/multi-session).
 */
const compactText = (t: string): string =>
  t
    .replace(/^### Turn (\d+) — (User|Assistant)\s*\|?\s*/gim, '[$1-$2] ')
    .replace(/^Timestamp: (.*)$/gim, '@$1')
    .replace(/^# Session .*\n?/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

interface Scored<T> { score: number; row: T }

const gateRows = <T>(rows: T[] | undefined, qWords: Set<string>, cap: number): Scored<T>[] => {
  if (!rows || rows.length === 0) return [];
  const scored: Scored<T>[] = [];
  for (const row of rows) {
    const text = Object.values(row as Record<string, unknown>).map(v => (typeof v === 'string' ? v : JSON.stringify(v) ?? '')).join(' ');
    let overlap = 0;
    for (const w of contentWords(text)) if (qWords.has(w)) overlap++;
    if (overlap > 0) scored.push({ score: overlap, row });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap);
};

export function compileContext(args: {
  question: CompilerQuestion;
  hits: CompilerHit[];
  tables: CompilerTables;
  dateMap: DateMap | null;
  maxContextTokens: number;
  compilerVersion: string;
  recencyOrder?: boolean;
}): CompiledContext {
  const { question, hits, tables, dateMap, maxContextTokens } = args;
  const qWords = contentWords(question.question);

  const parts: CompiledContext['parts'] = { rawTokens: 0, factsTokens: 0, chronicleTokens: 0, prefsTokens: 0 };
  type Excerpt = { text: string; date: string | null };
  const excerpts: Excerpt[] = [];

  // --- Structured rows first (gated) ---
  let tokens = 0;
  let remaining = maxContextTokens;
  const factScored = gateRows(tables.facts ?? [], qWords, 12);
  if (factScored.length) {
    const lines = factScored.map(({ row: f }) => {
      const co = f.coexist ? ` (also: ${f.coexist})` : '';
      return `- ${f.value} ${f.unit ?? ''} ${f.object ?? ''}${f.event ? ` — ${f.event}` : ''}${co}`.replace(/\s+/g, ' ').trim();
    });
    const block = `Numeric facts:\n${lines.join('\n')}\nCite only values present here; otherwise use excerpts.`;
    const blockTokens = countTextTokens(block);
    if (blockTokens <= remaining) {
      excerpts.push({ text: block, date: null });
      tokens += blockTokens;
      parts.factsTokens = blockTokens;
      remaining -= blockTokens;
    }
  }
  const chronScored = gateRows(tables.chronicle ?? [], qWords, 10);
  if (chronScored.length) {
    const lines = chronScored.map(({ row: e }) => `- ${e.when ?? ''}: ${e.event ?? ''}`.replace(/\s+/g, ' ').trim());
    const block = `Events:\n${lines.join('\n')}\nCite only events present here; otherwise use excerpts.`;
    const blockTokens = countTextTokens(block);
    if (blockTokens <= remaining) {
      excerpts.push({ text: block, date: null });
      tokens += blockTokens;
      parts.chronicleTokens = blockTokens;
      remaining -= blockTokens;
    }
  }
  const prefScored = gateRows(tables.prefs ?? [], qWords, 6);
  if (prefScored.length) {
    const lines = prefScored.map(({ row: p }) => `- ${p.statement ?? ''}`.replace(/\s+/g, ' ').trim());
    const block = `Standing preferences:\n${lines.join('\n')}\nApply matching entries; otherwise use excerpts.`;
    const blockTokens = countTextTokens(block);
    if (blockTokens <= remaining) {
      excerpts.push({ text: block, date: null });
      tokens += blockTokens;
      parts.prefsTokens = blockTokens;
      remaining -= blockTokens;
    }
  }

  // --- Raw excerpts: rank order, compact (dates preserved), recency-reordered ---
  type Raw = { text: string; date: string | null };
  const raws: Raw[] = [];
  const seen = new Set<string>();
  for (const hit of args.hits) {
    const text = compactText((hit.text ?? '').trim());
    if (!text || seen.has(hit.text ?? '')) continue;
    const sessionDate = dateMap?.get(canonicalSegment(hit.notePath)) ?? null;
    seen.add(hit.text ?? '');
    raws.push({ text, date: sessionDate });
  }
  // N22 recency ordering (newest-first) before selection.
  if (args.recencyOrder) {
    raws.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  }
  for (const raw of raws) {
    const dateMark = raw.date ? `(${compactDate(raw.date)}) ` : '';
    const candidate = `${dateMark}${raw.text}`;
    const candidateTokens = countTextTokens(candidate);
    if (tokens + candidateTokens > maxContextTokens) break;
    tokens += candidateTokens;
    excerpts.push({ text: candidate, date: raw.date });
  }
  parts.rawTokens = tokens - parts.factsTokens - parts.chronicleTokens - parts.prefsTokens;

  return {
    context: excerpts.map(excerpt => excerpt.text).join('\n\n'),
    tokens,
    parts,
    diagnostics: { compilerVersion: args.compilerVersion },
  };
}

export { canonicalSegment };