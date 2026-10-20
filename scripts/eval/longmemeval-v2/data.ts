import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * LongMemEval-V2 public data loader (arXiv 2605.12493; github.com/xiaowu0162/LongMemEval-V2, data on Hugging
 * Face `xiaowu0162/longmemeval-v2`). The format is read exactly as upstream `data/public_data.py` and
 * `memory_modules/trajectory_store.py` read it (upstream commit 2cc8c540, 2026-08-09):
 *
 *   <data-root>/questions.jsonl                 one question per line: id, domain, question_type, question, answer,
 *                                               eval_function, optional image
 *   <data-root>/trajectories.jsonl              one trajectory per line: id, domain, goal, start_url, outcome, states[]
 *   <data-root>/haystacks/lme_v2_<tier>.json    { question id: [trajectory id, ...] } in insertion order
 *
 * The data stays outside Git: the path is given on the command line. trajectories.jsonl is large (haystacks reach
 * 115M tokens), so it is never held in memory: one streaming pass hashes it and records the byte span of each
 * trajectory, and a trajectory is read back from its span when it is written into a workspace.
 */

export type LmeV2Domain = 'web' | 'enterprise';
export type LmeV2Tier = 'small' | 'medium';
export const LME_V2_DOMAINS: readonly LmeV2Domain[] = ['web', 'enterprise'];
export const LME_V2_TIERS: readonly LmeV2Tier[] = ['small', 'medium'];

export interface LmeV2Question {
  id: string;
  domain: LmeV2Domain;
  question_type: string;
  question: string;
  answer: string;
  eval_function: string;
  image?: string | null;
}

export interface LmeV2State {
  url: string;
  action?: string | null;
  thought?: string | null;
  thoughts?: string | null;
  accessibility_tree?: string;
  text?: string;
  screenshot?: string;
  step?: number;
  state_index?: number;
}

export interface LmeV2Trajectory {
  id: string;
  domain: LmeV2Domain;
  goal: string | string[];
  start_url: string;
  outcome?: string | null;
  states: LmeV2State[];
}

/** Upstream `CATEGORY_MAP` (evaluation/harness.py): question_type -> reporting category. */
export const LME_V2_CATEGORY_MAP: Readonly<Record<string, string>> = {
  'static-environment': 'static',
  'static-environment-abs': 'static-abs',
  'dynamic-environment': 'dynamic',
  'dynamic-environment-abs': 'dynamic-abs',
  procedure: 'procedure',
  'procedure-abs': 'procedure-abs',
  'errors-gotchas': 'gotchas',
};

export function categoryOf(questionType: string): string {
  const category = LME_V2_CATEGORY_MAP[questionType];
  if (!category) throw new Error(`Unexpected LongMemEval-V2 question_type: ${questionType}`);
  return category;
}

interface Span { offset: number; length: number; domain: string }

export interface LmeV2Data {
  root: string;
  tier: LmeV2Tier;
  questions: LmeV2Question[];
  haystacks: Record<string, string[]>;
  sha256: { questions: string; trajectories: string; haystack: string };
  trajectoryCount: number;
  /** Read one trajectory from trajectories.jsonl by its byte span. */
  readTrajectory(id: string): LmeV2Trajectory;
}

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

/** One streaming pass over a JSONL file: its sha256 and the byte span of every line, keyed by the line's `id`. */
function indexJsonl(file: string): { sha256: string; spans: Map<string, Span> } {
  require_(fs.existsSync(file), `Missing JSONL file: ${file}`);
  const hash = crypto.createHash('sha256');
  const spans = new Map<string, Span>();
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let pending: Buffer[] = [];
  let pendingStart = 0;
  let position = 0;
  let lineNo = 0;
  const finishLine = (line: Buffer, start: number) => {
    lineNo++;
    const text = line.toString('utf8').trim();
    if (!text) return;
    const row = JSON.parse(text) as { id?: unknown; domain?: unknown };
    require_(row && typeof row === 'object' && !Array.isArray(row), `Line ${lineNo} in ${file} is not a JSON object`);
    require_(typeof row.id === 'string' && row.id, `Invalid trajectory id on line ${lineNo} of ${file}`);
    require_(!spans.has(row.id), `Duplicate trajectory id: ${row.id}`);
    spans.set(row.id, { offset: start, length: line.length, domain: String(row.domain ?? '') });
  };
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (read === 0) break;
      const view = chunk.subarray(0, read);
      hash.update(view);
      let from = 0;
      for (let newline = view.indexOf(10, from); newline !== -1; newline = view.indexOf(10, from)) {
        pending.push(Buffer.from(view.subarray(from, newline)));
        finishLine(Buffer.concat(pending), pendingStart);
        pending = [];
        from = newline + 1;
        pendingStart = position + from;
      }
      if (from < read) pending.push(Buffer.from(view.subarray(from)));
      position += read;
    }
    if (pending.length) finishLine(Buffer.concat(pending), pendingStart);
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), spans };
}

function readJsonlRows(file: string): Array<Record<string, unknown>> {
  require_(fs.existsSync(file), `Missing JSONL file: ${file}`);
  return fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
    const row = JSON.parse(line) as unknown;
    require_(row && typeof row === 'object' && !Array.isArray(row), `Line ${index + 1} in ${file} is not a JSON object`);
    return row as Record<string, unknown>;
  });
}

function validateQuestion(row: Record<string, unknown>): LmeV2Question {
  const id = row.id;
  require_(typeof id === 'string' && id, 'Invalid question id');
  require_(LME_V2_DOMAINS.includes(row.domain as LmeV2Domain), `Invalid question domain: ${id}`);
  require_(typeof row.question === 'string' && row.question.trim(), `Invalid question text: ${id}`);
  require_(typeof row.question_type === 'string' && row.question_type, `Invalid question_type for ${id}`);
  categoryOf(row.question_type);
  require_(typeof row.eval_function === 'string' && row.eval_function, `Invalid eval_function for ${id}`);
  require_(typeof row.answer === 'string', `Invalid answer for ${id}`);
  require_(row.image == null || (typeof row.image === 'string' && row.image.trim()), `question image must be null or a string: ${id}`);
  // Upstream harness: an abstention-judged question must be an -abs question type.
  if (row.eval_function.split('|')[0].trim() === 'llm_abstention_checker') {
    require_(row.question_type.includes('-abs'), `llm_abstention_checker question must use an -abs question_type (qid=${id})`);
  }
  return row as unknown as LmeV2Question;
}

/**
 * Load and validate a LongMemEval-V2 data root for one tier: the same checks as upstream `validate_public_data`
 * (screenshots excepted — this adapter is text-only) plus the per-question checks of the upstream harness.
 */
export function loadLmeV2(dataRoot: string, tier: LmeV2Tier): LmeV2Data {
  require_(LME_V2_TIERS.includes(tier), '--tier must be small or medium');
  const root = path.resolve(dataRoot);
  const questionsPath = path.join(root, 'questions.jsonl');
  const trajectoriesPath = path.join(root, 'trajectories.jsonl');
  const haystackPath = path.join(root, 'haystacks', `lme_v2_${tier}.json`);
  require_(fs.existsSync(haystackPath), `Missing haystack file: ${haystackPath}`);

  const questions = readJsonlRows(questionsPath).map(validateQuestion);
  const seenQuestions = new Set<string>();
  for (const question of questions) {
    require_(!seenQuestions.has(question.id), `Duplicate question id: ${question.id}`);
    seenQuestions.add(question.id);
  }
  const haystackBytes = fs.readFileSync(haystackPath);
  const haystacks = JSON.parse(haystackBytes.toString('utf8')) as Record<string, unknown>;
  require_(haystacks && typeof haystacks === 'object' && !Array.isArray(haystacks), `Haystack file must be a JSON object: ${haystackPath}`);
  const index = indexJsonl(trajectoriesPath);

  for (const questionId of Object.keys(haystacks)) {
    require_(seenQuestions.has(questionId), `Haystack contains unknown question id ${questionId}`);
  }
  for (const question of questions) {
    const ids = haystacks[question.id];
    require_(Array.isArray(ids), `Missing haystack entry for question ${question.id}`);
    const seen = new Set<string>();
    for (const trajectoryId of ids) {
      require_(typeof trajectoryId === 'string' && trajectoryId, `Haystack for ${question.id} contains invalid trajectory ids`);
      const span = index.spans.get(trajectoryId);
      require_(span, `Unknown trajectory id ${trajectoryId} in ${question.id}`);
      require_(!seen.has(trajectoryId), `Duplicate trajectory id ${trajectoryId} in ${question.id}`);
      seen.add(trajectoryId);
      require_(span.domain === question.domain, `Cross-domain trajectory ${trajectoryId} in haystack for ${question.id}`);
    }
  }

  return {
    root,
    tier,
    questions,
    haystacks: haystacks as Record<string, string[]>,
    sha256: { questions: sha256(fs.readFileSync(questionsPath)), trajectories: index.sha256, haystack: sha256(haystackBytes) },
    trajectoryCount: index.spans.size,
    readTrajectory(id: string): LmeV2Trajectory {
      const span = index.spans.get(id);
      require_(span, `Unknown trajectory id ${id}`);
      const buffer = Buffer.alloc(span.length);
      const fd = fs.openSync(trajectoriesPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, span.length, span.offset);
      } finally {
        fs.closeSync(fd);
      }
      return validateTrajectory(JSON.parse(buffer.toString('utf8')) as Record<string, unknown>);
    },
  };
}

function validateTrajectory(row: Record<string, unknown>): LmeV2Trajectory {
  const id = row.id as string;
  require_(Array.isArray(row.states) && row.states.length > 0, `trajectory ${id} has no states (only the public states format is supported)`);
  require_(typeof row.goal === 'string' || Array.isArray(row.goal), `trajectory goal must be a string for ${id}`);
  require_(typeof row.start_url === 'string' && row.start_url.trim(), `trajectory start_url must be a non-empty string for ${id}`);
  require_(row.outcome == null || typeof row.outcome === 'string', `trajectory outcome must be a string or null for ${id}`);
  (row.states as unknown[]).forEach((state, index) => {
    require_(state && typeof state === 'object', `trajectory ${id} state ${index} must be an object`);
    const s = state as LmeV2State;
    require_(typeof s.url === 'string' && s.url.trim(), `trajectory ${id} state ${index} missing url`);
    require_(typeof (s.accessibility_tree ?? s.text) === 'string', `trajectory ${id} state ${index} accessibility_tree/text must be string`);
  });
  return row as unknown as LmeV2Trajectory;
}

/** Upstream `goal_text`. */
export function goalText(goal: unknown): string {
  if (typeof goal === 'string') return goal.trim() || '<goal not found>';
  if (Array.isArray(goal)) {
    const parts = goal.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).map(part => part.trim());
    if (parts.length) return parts.join(' ');
  }
  return '<goal not found>';
}

/**
 * One trajectory as one markdown note: goal, start URL, outcome, then every state's URL, thought, action and page
 * text (the accessibility tree), which is everything upstream's text memory systems receive on insert. Screenshots
 * are not rendered. `maxStateChars` > 0 caps each state's page text; 0 keeps it whole. `position` is the
 * trajectory's insertion order in the haystack, which the benchmark gives every memory system.
 */
export function renderTrajectory(trajectory: LmeV2Trajectory, position: number, maxStateChars = 0): string {
  const steps = trajectory.states.map((state, index) => {
    const thought = state.thought ?? state.thoughts;
    const page = state.accessibility_tree ?? state.text ?? '';
    const pageText = maxStateChars > 0 && page.length > maxStateChars ? `${page.slice(0, maxStateChars)}\n[page text truncated]` : page;
    return [
      `## Step ${index + 1}`,
      '',
      `URL: ${state.url}`,
      ...(thought ? [`Thought: ${thought}`] : []),
      ...(state.action ? [`Action: ${state.action}`] : []),
      ...(pageText.trim() ? ['', 'Page:', '', pageText.trim()] : []),
    ].join('\n');
  }).join('\n\n');
  return [
    '---',
    'kind: longmemeval-v2-trajectory',
    `trajectory_id: ${JSON.stringify(trajectory.id)}`,
    `haystack_position: ${position}`,
    '---',
    `# Trajectory ${trajectory.id}`,
    '',
    `Goal: ${goalText(trajectory.goal)}`,
    `Start URL: ${trajectory.start_url}`,
    ...(trajectory.outcome ? [`Outcome: ${trajectory.outcome}`] : []),
    '',
    steps,
    '',
  ].join('\n');
}

export function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${normalized.slice(0, 80) || 'trajectory'}-${sha256(value).slice(0, 10)}`;
}

/** A haystack's identity: sha256 of its ordered trajectory ids. Questions with the same haystack share one workspace. */
export function haystackKey(trajectoryIds: readonly string[]): string {
  return sha256(trajectoryIds.join('\n'));
}
