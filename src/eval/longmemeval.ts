export interface LongMemTurn { role: string; content: string; has_answer?: boolean }
export interface LongMemInstance {
  question_id: string; question_type: string; question: string; answer: string;
  question_date: string; haystack_session_ids: string[]; haystack_dates: string[];
  haystack_sessions: LongMemTurn[][]; answer_session_ids: string[];
}

/** Upstream timestamps have no zone. Interpret them as UTC, never host-local time. */
export function parseTimestamp(value: string): Date {
  const official = /^(\d{4})\/(\d{2})\/(\d{2})(?: \([A-Za-z]{3}\))?(?: (\d{2}):(\d{2}))?$/.exec(value);
  const iso = official ? `${official[1]}-${official[2]}-${official[3]}T${official[4] ?? '00'}:${official[5] ?? '00'}:00Z` : value;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) throw new Error(`Ambiguous timestamp: ${value}`);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || (official && date.toISOString().slice(0, 16) !== iso.slice(0, 16))) throw new Error(`Invalid timestamp: ${value}`);
  return date;
}

function uniqueStrings(values: string[], label: string): void {
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v.trim())) throw new Error(`Invalid ${label}`);
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
export function validateLongMemRows(rows: LongMemInstance[]): void {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Empty/invalid LongMemEval dataset');
  uniqueStrings(rows.map(r => r.question_id), 'question id');
  for (const row of rows) {
    if (!row.question?.trim() || !row.question_type?.trim()) throw new Error('Missing question/type');
    parseTimestamp(row.question_date);
    uniqueStrings(row.answer_session_ids, 'answer session id');
    // Official data may repeat a noise haystack session id; a repeated ANSWER id
    // would make evidence mapping ambiguous and stays rejected.
    const seenAnswer = new Set(row.answer_session_ids);
    const haystackCounts = new Map<string, number>();
    for (const id of row.haystack_session_ids) {
      haystackCounts.set(id, (haystackCounts.get(id) ?? 0) + 1);
      if ((haystackCounts.get(id) ?? 0) > 1 && seenAnswer.has(id)) {
        throw new Error(`Duplicated answer session id in haystack: ${id}`);
      }
    }
    if (!Array.isArray(row.haystack_sessions) || !Array.isArray(row.haystack_dates)
        || row.haystack_sessions.length !== row.haystack_session_ids.length
        || row.haystack_dates.length !== row.haystack_session_ids.length) throw new Error('Haystack arrays differ in length');
    row.haystack_dates.forEach(parseTimestamp);
    // Official data legitimately contains empty noise sessions; roles/content stay strict.
    for (const turns of row.haystack_sessions) {
      if (!Array.isArray(turns) || turns.some(t => !['user', 'assistant'].includes(t.role) || typeof t.content !== 'string')) {
        throw new Error('Invalid session turns');
      }
    }
    if (!row.question_id.endsWith('_abs') && (!row.answer_session_ids.length
        || row.answer_session_ids.some(id => !row.haystack_session_ids.includes(id)))) throw new Error('Missing answer evidence sessions');
  }
}
