/**
 * LongMemEval-V2 scoring, ported line for line from upstream `evaluation/qa_eval_metrics.py` and the scoring and
 * aggregation in `evaluation/harness.py` (commit 2cc8c540). Every question names its own eval function as a spec
 * string, `name|key=value|...`. Four are deterministic; two (abstention, gotchas) call an LLM judge with the
 * upstream prompts below. A reply of exactly `\boxed{UNKNOWN}` scores 0 whatever the function says.
 *
 * Python `\w` / `\b` are Unicode-aware; the JS port uses \p{L}\p{N}_ classes and lookarounds to match them.
 */

export const DETERMINISTIC_EVAL_FUNCTIONS = ['norm_phrase_set_match', 'norm_phrase_set_match_ordered', 'mc_choice_match', 'mc_choice_set_match'] as const;
export const LLM_EVAL_FUNCTIONS = ['llm_abstention_checker', 'llm_gotchas_checker'] as const;
export type LlmEvalFunction = typeof LLM_EVAL_FUNCTIONS[number];

const WORD = '\\p{L}\\p{N}_';
const DEFAULT_SEPARATORS = [',', ';'];

export interface NormalizeOptions { lower?: boolean; normalize_hyphen?: boolean; strip_punct?: boolean }

export function normalizePhrase(text: unknown, opts: NormalizeOptions = {}): string {
  const { lower = true, normalize_hyphen = true, strip_punct = true } = opts;
  if (text === null || text === undefined) return '';
  let out = typeof text === 'string' ? text : String(text);
  if (lower) out = out.toLowerCase();
  if (normalize_hyphen) out = out.replaceAll('-', ' ').replaceAll('_', ' ');
  out = out.replace(/[,;]/g, ' ');
  if (strip_punct) out = out.replace(new RegExp(`[^${WORD}\\s]`, 'gu'), '');
  return out.replace(/\s+/g, ' ').trim();
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordBounded = (phrase: string) => new RegExp(`(?<![${WORD}])${escapeRegex(phrase)}(?![${WORD}])`, 'u');

export function splitPhrases(text: unknown, separators: string[] = DEFAULT_SEPARATORS, opts: NormalizeOptions = {}): string[] {
  if (text === null || text === undefined) return [];
  const raw = typeof text === 'string' ? text : String(text);
  if (separators.length === 0) {
    const normalized = normalizePhrase(raw, opts);
    return normalized ? [normalized] : [];
  }
  const pattern = new RegExp(separators.map(escapeRegex).join('|'));
  return raw.split(pattern).map(part => normalizePhrase(part, opts)).filter(Boolean);
}

interface SpecOptions extends NormalizeOptions {
  separators?: string[];
  require_non_empty?: boolean;
  strip_chars?: string;
}

export function normPhraseSetMatch(prediction: unknown, answer: unknown, opts: SpecOptions = {}): boolean {
  const { separators = DEFAULT_SEPARATORS, require_non_empty = true } = opts;
  const pred = normalizePhrase(prediction, opts);
  const phrases = splitPhrases(answer, separators, opts);
  if (require_non_empty && (!pred || phrases.length === 0)) return false;
  return [...new Set(phrases)].every(phrase => wordBounded(phrase).test(pred));
}

export function normPhraseSetMatchOrdered(prediction: unknown, answer: unknown, opts: SpecOptions = {}): boolean {
  const { separators = DEFAULT_SEPARATORS, require_non_empty = true } = opts;
  const pred = normalizePhrase(prediction, opts);
  const phrases = splitPhrases(answer, separators, opts);
  if (require_non_empty && (!pred || phrases.length === 0)) return false;
  let start = 0;
  for (const phrase of phrases) {
    // Python re.search on the slice: lookbehind at the slice start sees nothing, so slice first.
    const rest = pred.slice(start);
    const match = wordBounded(phrase).exec(rest);
    if (!match) return false;
    start += match.index + match[0].length;
  }
  return true;
}

export function mcChoiceMatch(prediction: unknown, answer: unknown, opts: SpecOptions = {}): boolean {
  const { strip_chars = '.', require_non_empty = true } = opts;
  if (prediction === null || prediction === undefined || answer === null || answer === undefined) return false;
  const pred = typeof prediction === 'string' ? prediction : String(prediction);
  const gold = typeof answer === 'string' ? answer : String(answer);
  const boxed = /\\boxed\{([^}]*)\}/.exec(pred.toLowerCase());
  let cleaned = (boxed ? boxed[1] : pred).replace(new RegExp(`(?<![${WORD}])(choice|option)(?![${WORD}])`, 'giu'), '');
  for (const ch of strip_chars) cleaned = cleaned.replaceAll(ch, '');
  cleaned = cleaned.trim().toUpperCase();
  const expected = gold.trim().toUpperCase();
  if (require_non_empty && (!cleaned || !expected)) return false;
  return cleaned === expected;
}

const MULTI_SELECT_FILLER_WORDS = new Set(['AND', 'ANSWER', 'ANSWERS', 'CHOICE', 'CHOICES', 'FINAL', 'LETTER', 'LETTERS', 'OPTION', 'OPTIONS']);

function multiSelectLetters(text: unknown): string[] {
  if (text === null || text === undefined) return [];
  const chunks = (typeof text === 'string' ? text : String(text)).toUpperCase().match(/[A-Z]+/g) ?? [];
  return chunks.filter(chunk => !MULTI_SELECT_FILLER_WORDS.has(chunk)).flatMap(chunk => [...chunk]);
}

export function mcChoiceSetMatch(prediction: unknown, answer: unknown, opts: SpecOptions = {}): boolean {
  const { require_non_empty = true } = opts;
  const pred = multiSelectLetters(prediction);
  const gold = multiSelectLetters(answer);
  if (require_non_empty && (pred.length === 0 || gold.length === 0)) return false;
  const a = new Set(pred);
  const b = new Set(gold);
  return a.size === b.size && [...a].every(letter => b.has(letter));
}

/** Upstream `extract_boxed_answer`: the content of the LAST `\boxed{...}`, braces balanced; the whole text when absent or empty. */
export function extractBoxedAnswer(text: string): string {
  const marker = '\\boxed{';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return text.trim();
  let depth = 1;
  let out = '';
  for (let i = idx + marker.length; i < text.length && depth > 0; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    out += ch;
  }
  const parsed = out.trim();
  return parsed || text.trim();
}

export const isUnknown = (parsed: string) => parsed.trim().toLowerCase() === 'unknown';

export const evalName = (spec: string) => spec.split('|')[0].trim();

function parseEvalValue(key: string, value: string): unknown {
  const lowered = value.toLowerCase();
  if (lowered === 'true' || lowered === 'false') return lowered === 'true';
  if (lowered === 'none' || lowered === 'null') return null;
  if (key === 'separators' || key === 'separator') {
    if (!value) return [];
    const stripped = value.trim();
    if (stripped.startsWith('[') && stripped.endsWith(']')) return JSON.parse(stripped) as string[];
    return [...value].filter(ch => !/\s/.test(ch));
  }
  // Python: int() / float() on the string, falling back to the string itself.
  if (/^[\s]*[+-]?\d+[\s]*$/.test(value) && !value.includes('.')) return Number.parseInt(value, 10);
  if (value.includes('.') && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

/** Upstream `parse_eval_function_spec`; unknown names and malformed options throw. */
export function parseEvalSpec(spec: string): { name: string; options: Record<string, unknown> } {
  if (!spec || typeof spec !== 'string') throw new Error('eval function spec must be a non-empty string.');
  const parts = spec.split('|').map(part => part.trim());
  const name = parts[0];
  if (!name) throw new Error('eval function spec missing function name.');
  if (!(DETERMINISTIC_EVAL_FUNCTIONS as readonly string[]).includes(name) && !(LLM_EVAL_FUNCTIONS as readonly string[]).includes(name)) {
    throw new Error(`Unknown eval function: ${name}`);
  }
  const options: Record<string, unknown> = {};
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) throw new Error(`Invalid eval function option: ${part}`);
    const key = part.slice(0, eq).trim();
    if (!key) throw new Error(`Invalid eval function option: ${part}`);
    if (key in options) throw new Error(`Duplicate eval function option: ${key}`);
    options[key] = parseEvalValue(key, part.slice(eq + 1).trim());
  }
  return { name, options };
}

export function isLlmJudged(spec: string): boolean {
  return (LLM_EVAL_FUNCTIONS as readonly string[]).includes(evalName(spec));
}

/** A deterministic eval function applied to the parsed `\boxed{}` answer. */
export function scoreDeterministic(spec: string, parsedPrediction: string, gold: string): boolean {
  const { name, options } = parseEvalSpec(spec);
  const opts = options as SpecOptions;
  switch (name) {
    case 'norm_phrase_set_match': return normPhraseSetMatch(parsedPrediction, gold, opts);
    case 'norm_phrase_set_match_ordered': return normPhraseSetMatchOrdered(parsedPrediction, gold, opts);
    case 'mc_choice_match': return mcChoiceMatch(parsedPrediction, gold, opts);
    case 'mc_choice_set_match': return mcChoiceSetMatch(parsedPrediction, gold, opts);
    default: throw new Error(`${name} is not a deterministic eval function`);
  }
}

// ---- LLM judges (verbatim upstream prompts) ----

const ABSTENTION_JUDGE_SYSTEM_PROMPT = 'You are a strict grader for flawed-premise (abstention) questions. '
  + 'Judge whether a model answer correctly identifies that the question premise is wrong, '
  + 'consistent with the reference answer. '
  + 'If the model follows the flawed premise and gives a concrete answer under that premise, '
  + 'it must be graded 0. '
  + 'If the model\'s final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. '
  + 'If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. '
  + 'Paraphrases are allowed when they preserve the same core flaw described by the reference answer.';

const GOTCHAS_JUDGE_SYSTEM_PROMPT = 'You are a strict grader for gotchas-style insight questions. '
  + 'The reference answer describes the key insight(s). '
  + 'Grade 1 if the model response includes at least one correct insight point from the reference answer '
  + '(paraphrase allowed), and does not contradict any reference point. '
  + 'If the model\'s direction is wrong, or it contains contradictions against any reference point, grade 0. '
  + 'If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear.';

export interface JudgeMessage { role: 'system' | 'user'; content: string }

export function buildJudgeMessages(name: LlmEvalFunction, args: { question: string; reference: string; fullResponse: string; finalAnswer: string }): JudgeMessage[] {
  if (name === 'llm_abstention_checker') {
    const user = 'Evaluate whether the model correctly handled a flawed-premise question.\n\n'
      + `Question:\n${args.question}\n\n`
      + `Reference answer (the expected flaw-aware conclusion):\n${args.reference}\n\n`
      + `Model full response:\n${args.fullResponse}\n\n`
      + `Model extracted final answer:\n${args.finalAnswer}\n\n`
      + 'Scoring rubric:\n'
      + '- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion '
      + 'equivalent to the reference answer.\n'
      + '- Label 1 also if the model explicitly says it lacks access to the user\'s specific '
      + 'live environment/instance/configuration and therefore cannot verify, provided it does not '
      + 'give a concrete premise-following answer.\n'
      + '- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.\n'
      + '- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not '
      + 'make the explicit environment-access limitation clear.\n'
      + '- Label 0 if contradictory.\n\n'
      + 'Output JSON only:\n'
      + '{"label": 0 or 1, "reason": "short rationale"}';
    return [{ role: 'system', content: ABSTENTION_JUDGE_SYSTEM_PROMPT }, { role: 'user', content: user }];
  }
  const user = 'Evaluate whether the model answer captures the gotcha insight.\n\n'
    + `Question:\n${args.question}\n\n`
    + `Reference answer (insight points):\n${args.reference}\n\n`
    + `Model full response:\n${args.fullResponse}\n\n`
    + `Model extracted final answer:\n${args.finalAnswer}\n\n`
    + 'Scoring rubric:\n'
    + '- Label 1 if the model includes at least one correct insight point from the reference answer '
    + '(paraphrase acceptable), and does not contradict any reference point.\n'
    + '- Label 1 even if only part of a multi-point reference answer is covered, as long as there is '
    + 'no contradiction.\n'
    + '- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.\n'
    + '- Label 0 if any point in the model response contradicts any reference point.\n'
    + '- Label 0 if the response is irrelevant or generic without insight.\n\n'
    + 'Output JSON only:\n'
    + '{"label": 0 or 1, "reason": "short rationale"}';
  return [{ role: 'system', content: GOTCHAS_JUDGE_SYSTEM_PROMPT }, { role: 'user', content: user }];
}

/** Upstream `_parse_llm_binary_judgement`; null where upstream raises (the case is then a judge error, never a 0). */
export function parseJudgeLabel(text: string): 0 | 1 | null {
  let cleaned = (text ?? '').trim();
  if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    const lines = cleaned.split('\n');
    if (lines.length >= 3) cleaned = lines.slice(1, -1).join('\n').trim();
  }
  if (!cleaned) return null;
  const blob = /\{[\s\S]*\}/.exec(cleaned);
  if (blob) {
    try {
      const payload = JSON.parse(blob[0]) as { label?: unknown };
      if (payload && typeof payload === 'object' && [0, 1, '0', '1'].includes(payload.label as never)) return Number(payload.label) as 0 | 1;
    } catch { /* fall through to the regex forms, as upstream does */ }
  }
  const match = /"label"\s*:\s*([01])/i.exec(cleaned) ?? /'label'\s*:\s*([01])/i.exec(cleaned) ?? /\blabel\b\s*[:=]\s*([01])/i.exec(cleaned);
  return match ? (Number(match[1]) as 0 | 1) : null;
}

// ---- Aggregation (upstream aggregate_metrics) ----

export const NON_ABSTENTION_CATEGORIES = ['static', 'dynamic', 'procedure', 'gotchas'] as const;
export const ABSTENTION_CATEGORIES = ['static-abs', 'dynamic-abs', 'procedure-abs'] as const;
const COMBINED_ABSTENTION_CATEGORY_PAIRS: Record<string, [string, string]> = {
  static: ['static', 'static-abs'],
  dynamic: ['dynamic', 'dynamic-abs'],
  procedure: ['procedure', 'procedure-abs'],
};

export interface ScoredRecord {
  category: string;
  isAbstentionProblem: boolean;
  isUnknown: boolean;
  scoreBool: boolean;
}

export interface Breakdown { count: number; pct_correct: number | null; pct_answered_wrong: number | null; pct_unknown: number | null }

function breakdown(rows: ScoredRecord[]): Breakdown {
  const n = rows.length;
  if (n === 0) return { count: 0, pct_correct: null, pct_answered_wrong: null, pct_unknown: null };
  const unknown = rows.filter(r => r.isUnknown).length;
  const correct = rows.filter(r => r.scoreBool && !r.isUnknown).length;
  return { count: n, pct_correct: correct / n, pct_answered_wrong: (n - correct - unknown) / n, pct_unknown: unknown / n };
}

const meanScore = (rows: ScoredRecord[]) => (rows.length ? rows.filter(r => r.scoreBool).length / rows.length : null);

/**
 * The upstream `aggregated_metrics.json` shape. Over several domains' records at once it equals upstream's
 * example-count-weighted combination (leaderboard/combine_aggregated_metrics.py), since every figure is a mean.
 */
export function aggregateMetrics(records: ScoredRecord[]) {
  if (records.length === 0) throw new Error('No records to aggregate');
  const nonAbst = records.filter(r => !r.isAbstentionProblem);
  const abst = records.filter(r => r.isAbstentionProblem);
  return {
    overall: {
      overall_full_set: meanScore(records),
      overall_non_abstention_only: meanScore(nonAbst),
      overall_abstention_only: meanScore(abst),
      count_all_questions: records.length,
      count_non_abstention: nonAbst.length,
      count_abstention: abst.length,
    },
    non_abstention_by_category: Object.fromEntries(NON_ABSTENTION_CATEGORIES.map(cat => [cat, breakdown(nonAbst.filter(r => r.category === cat))])),
    abstention_by_category: Object.fromEntries(ABSTENTION_CATEGORIES.map(cat => [cat, breakdown(abst.filter(r => r.category === cat))])),
    combined_abstention_by_category: Object.fromEntries(Object.entries(COMBINED_ABSTENTION_CATEGORY_PAIRS)
      .map(([cat, pair]) => [cat, breakdown(records.filter(r => pair.includes(r.category)))])),
    abstention_overall: breakdown(abst),
  };
}
