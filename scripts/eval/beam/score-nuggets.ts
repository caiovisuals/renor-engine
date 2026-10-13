/**
 * BEAM Nugget Scorer (scripts/eval/beam/score-nuggets.ts).
 *
 * Implements BEAM's canonical LLM-as-judge scoring per atomic nugget:
 * - Judge: gemma4:31b via Ollama at temp 0
 * - Prompt: official unified_llm_judge_base_prompt (byte-identical, including
 *   the leading/trailing newlines from src/prompts.py)
 * - Metric: 1.0 (full compliance), 0.5 (partial), 0.0 (no compliance)
 * - Deterministic parsing with fallback recovery and parse failure tracking
 * - Aggregation: per-question score -> per-capability score -> overall macro score
 * - Eval cache support for cheap development/replay runs; --no-cache for
 *   authoritative runs. Cache APIs match scripts/eval/run-longmemeval-qa.ts.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import {
  EvalCache,
  KeyPool,
  WorkerPool,
  resolveJudgeKeys,
  resolveEvalCachePath,
  runWithKeyPoolRetries,
  resolveWorkerConcurrency,
  resolveCacheScope,
} from '../../../src/eval/evalCache';
import type { EvalCacheEntry } from '../../../src/eval/evalCache';
import { claimDirectory } from '../../../src/eval/artifacts';
import { evaluatorSourceHash, gitState } from '../../../src/eval/runManifest';

/**
 * Official BEAM unified_llm_judge_base_prompt, including the leading and
 * trailing newlines from github.com/mohammadtavakoli78/BEAM src/prompts.py.
 * Keep this byte-identical; tests pin the sha256.
 */
export const UNIFIED_LLM_JUDGE_BASE_PROMPT = `
You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- RUBRIC CRITERION (what to check): <rubric_item>
- RESPONSE TO EVALUATE: <llm_response>

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate. 

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")

## RESPONSIVENESS REQUIREMENT
A compliant response must be **on-topic** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept **paraphrases** and **synonyms** that preserve intent.
- **Case/punctuation/whitespace** differences must be ignored.
- **Numbers/currencies/dates** may appear in equivalent forms (e.g., “$68,000”, “68k”, “68,000 USD”, or “sixty-eight thousand dollars”). Treat them as equal when numerically equivalent.
- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.

## STYLE NEUTRALITY (prevents style contamination):
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., “itemized list”, “no citations”, “one sentence”).
- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric **explicitly** mandates it.

## SCORING SCALE:
- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.
  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).
  - Negative: prohibited element **absent** AND response is **responsive**.
  
- **0.5 (Partial Compliance)**: Partially complies.
  - Positive: element present but minor inaccuracies/incomplete execution.
  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.
  
- **0.0 (No Compliance)**: Fails to comply.
  - Positive: required element missing or incorrect.
  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.

## EVALUATION INSTRUCTIONS:
1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).

2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:
   - **All elements** must be present for full compliance (1.0)
   - **Some elements** present indicates partial compliance (0.5)
   - **No elements** present indicates no compliance (0.0)
   
3. **Check Compliance**: 
   - For positive requirements: Look for the presence and quality of the required element
   - For negative constraints: Look for the absence of the prohibited element

4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.

5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.

## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:

{
   "score": [your score: 1.0, 0.5, or 0.0],
   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"
}

NOTE: ONLY output the json object, without any explanation before or after that
`;

export const OFFICIAL_PROMPT_SHA256 = '593373c642a288a7b590577d8a8fc92c3f9a2b70e2f64ad6e59a040a6c56b7f5';

export function renderJudgePrompt(rubricItem: string, llmResponse: string): string {
  return UNIFIED_LLM_JUDGE_BASE_PROMPT
    .replace('<rubric_item>', rubricItem)
    .replace('<llm_response>', llmResponse);
}

const ALLOWED_SCORES = new Set([0, 0.5, 1]);

export function parseNuggetScore(raw: string): { score: number | null; reason: string; parseError?: string } {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const tryParse = (text: string): { score: number; reason: string } | null => {
    try {
      const parsed = JSON.parse(text) as { score?: unknown; reason?: unknown };
      const num = Number(parsed.score);
      if (ALLOWED_SCORES.has(num)) {
        return { score: num, reason: String(parsed.reason ?? '') };
      }
    } catch {
      return null;
    }
    return null;
  };

  const direct = tryParse(cleaned);
  if (direct) return direct;

  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const nested = tryParse(objMatch[0]);
    if (nested) return nested;
  }

  return {
    score: null,
    reason: '',
    parseError: `Failed to parse score from: ${raw.slice(0, 150)}`,
  };
}

export interface NuggetEval {
  criterion: string;
  score: number | null;
  reason: string;
  rawContent?: string;
  parseError?: string;
}

export interface QuestionNuggetResult {
  id: string;
  category: string;
  question: string;
  llmResponse: string;
  expectedAnswer: string;
  nuggets: NuggetEval[];
  questionScore: number | null;
}

export interface CapabilityScoreSummary {
  count: number;
  meanScore: number;
  parseFailures: number;
}

export interface ScoreReport {
  overallScore: number;
  byCapability: Record<string, CapabilityScoreSummary>;
  totalQuestions: number;
  scoredQuestions: number;
  totalNuggets: number;
  parseFailures: number;
  valid: boolean;
}

export function questionScoreFromNuggets(nuggets: Array<{ score: number | null }>): number | null {
  if (nuggets.length === 0 || nuggets.some(n => n.score === null)) return null;
  const scores = nuggets.map(n => n.score as number);
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
export function assertAuthoritativeReport(report: ScoreReport, cacheEnabled: boolean): void {
  if (!cacheEnabled && report.parseFailures > 0) {
    throw new Error(
      `Authoritative BEAM scoring is invalid: ${report.parseFailures} judge parse failure(s). ` +
      'Artifacts were written for inspection; rerun after resolving every parse failure.',
    );
  }
}

export function aggregateScores(results: QuestionNuggetResult[]): ScoreReport {
  const byCat: Record<string, { scores: number[]; parseFailures: number }> = {};
  let totalNuggets = 0;
  let totalParseFailures = 0;

  for (const r of results) {
    if (!byCat[r.category]) {
      byCat[r.category] = { scores: [], parseFailures: 0 };
    }
    for (const n of r.nuggets) {
      totalNuggets++;
      if (n.score === null) {
        totalParseFailures++;
        byCat[r.category].parseFailures++;
      }
    }
    if (r.questionScore !== null) {
      byCat[r.category].scores.push(r.questionScore);
    }
  }

  const byCapability: Record<string, CapabilityScoreSummary> = {};
  const capMeans: number[] = [];
  for (const [cat, data] of Object.entries(byCat).sort(([a], [b]) => a.localeCompare(b))) {
    const mean = data.scores.length > 0
      ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length
      : 0;
    byCapability[cat] = {
      count: data.scores.length,
      meanScore: Math.round(mean * 1000) / 1000,
      parseFailures: data.parseFailures,
    };
    if (data.scores.length > 0) capMeans.push(mean);
  }

  const overall = capMeans.length > 0
    ? capMeans.reduce((a, b) => a + b, 0) / capMeans.length
    : 0;

  return {
    overallScore: Math.round(overall * 1000) / 1000,
    byCapability,
    totalQuestions: results.length,
    scoredQuestions: Object.values(byCat).reduce((sum, data) => sum + data.scores.length, 0),
    totalNuggets,
    parseFailures: totalParseFailures,
    valid: totalParseFailures === 0,
  };
}

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function chatCall(args: {
  baseUrl: string;
  apiKey: string;
  requestBody: Record<string, unknown>;
  timeoutMs: number;
  retries: number;
  onHttpError?: (status: number, retryAfterMs?: number) => void;
}): Promise<{ body: ChatResponse; latencyMs: number; attempts: number }> {
  const url = `${args.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= args.retries; attempt++) {
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify(args.requestBody),
        signal: AbortSignal.timeout(args.timeoutMs),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        args.onHttpError?.(resp.status);
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }

      const body = await resp.json() as ChatResponse;
      return { body, latencyMs: Date.now() - t0, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < args.retries) {
        await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** attempt, 10_000)));
      }
    }
  }
  throw lastError ?? new Error('chatCall failed');
}

async function main(): Promise<void> {
  const program = new Command()
    .name('score-beam-nuggets')
    .requiredOption('--qa <path>', 'qa-cases.jsonl from the QA runner')
    .requiredOption('--cases <path>', 'cases.jsonl from adapter with rubrics')
    .requiredOption('--output <dir>', 'output directory for scores and report')
    .option('--judge-model <model>', 'judge model identifier', 'gemma4:31b')
    .option('--judge-base-url <url>', 'judge API base URL', 'https://ollama.com/v1')
    .option('--judge-keys-env <prefix>', 'env prefix for judge keys', 'OLLAMA_CLOUD_KEY')
    .option('--concurrency <n>', 'worker concurrency', '3')
    .option('--cache-dir <path>', 'eval cache sqlite path')
    .option('--no-cache', 'disable eval cache (cold authoritative scoring)')
    .option('--limit <n>', 'max questions to evaluate (0 = all)', '0')
    .parse(process.argv);

  const opts = program.opts<{
    qa: string;
    cases: string;
    output: string;
    judgeModel: string;
    judgeBaseUrl: string;
    judgeKeysEnv: string;
    concurrency: string;
    cacheDir?: string;
    cache?: boolean;
    limit: string;
  }>();

  const qaPath = path.resolve(opts.qa);
  const casesPath = path.resolve(opts.cases);
  const outputDir = path.resolve(opts.output);
  claimDirectory(outputDir);

  const qaRows = fs.readFileSync(qaPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => JSON.parse(l) as {
      id: string;
      answer?: { text?: string } | string;
      question?: string;
      raw?: string;
    });

  const casesRows = fs.readFileSync(casesPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => JSON.parse(l) as {
      id: string;
      rubric: string[];
      category: string;
      expectedAnswer: string;
      query: string;
    });

  const casesMap = new Map(casesRows.map(c => [c.id, c]));
  const limit = Number(opts.limit ?? 0);
  const selectedQa = limit > 0 ? qaRows.slice(0, limit) : qaRows;

  const judgeKeys = resolveJudgeKeys(process.env, opts.judgeKeysEnv);
  if (judgeKeys.length === 0) {
    throw new Error(`No judge API keys available (${opts.judgeKeysEnv}_1..N)`);
  }

  const judgeKeyPool = new KeyPool(judgeKeys, 1);
  const concurrency = resolveWorkerConcurrency(opts.concurrency, judgeKeyPool.size);

  const cacheEnabled = opts.cache !== false;
  const cachePath = cacheEnabled
    ? (opts.cacheDir ? path.resolve(opts.cacheDir) : resolveEvalCachePath(process.env))
    : null;
  const evalCache = cachePath ? new EvalCache(cachePath) : null;
  const routingSession = process.env.RENOR_QA_SESSION ?? `beam-judge-${process.pid}-${Date.now().toString(36)}`;
  const cacheScope = resolveCacheScope({
    explicit: process.env.RENOR_QA_CACHE_SCOPE,
    session: routingSession,
  });

  const judgeNamespace = `${opts.judgeBaseUrl}#${opts.judgeModel}`;
  const results: QuestionNuggetResult[] = [];
  const startedAt = new Date().toISOString();
  const workerPool = new WorkerPool(concurrency);

  process.stderr.write(
    `[beam-judge] scoring ${selectedQa.length} questions (concurrency ${concurrency}, keys ${judgeKeyPool.size}, cache ${evalCache ? 'on' : 'off'}, scope ${cacheScope})\n`,
  );

  await Promise.all(selectedQa.map(qaItem => workerPool.run(async () => {
    const caseItem = casesMap.get(qaItem.id);
    if (!caseItem) {
      throw new Error(`question ${qaItem.id} missing from cases.jsonl`);
    }

    const llmResponse = typeof qaItem.answer === 'string'
      ? qaItem.answer
      : (qaItem.answer?.text ?? qaItem.raw ?? '');
    const rubrics = caseItem.rubric ?? [];
    if (rubrics.length === 0) {
      throw new Error(`question ${qaItem.id} has empty rubric`);
    }
    const nuggets: NuggetEval[] = [];

    for (const rubricItem of rubrics) {
      const prompt = renderJudgePrompt(rubricItem, llmResponse);
      const requestBody = {
        model: opts.judgeModel,
        messages: [{ role: 'user' as const, content: prompt }],
        temperature: 0,
      };

      const cacheKey = evalCache
        ? EvalCache.computeKey(judgeNamespace, requestBody, cacheScope)
        : null;

      let rawContent = '';
      let modelEcho = opts.judgeModel;
      let finishReason = '';
      let promptTokens = 0;
      let completionTokens = 0;
      let latencyMs = 0;
      let fromCache = false;

      const cached = evalCache && cacheKey ? evalCache.get(cacheKey, 'judge') : null;
      if (cached) {
        rawContent = cached.rawContent;
        modelEcho = cached.modelEcho;
        finishReason = cached.finishReason;
        promptTokens = cached.promptTokens;
        completionTokens = cached.completionTokens;
        latencyMs = cached.latencyMs;
        fromCache = true;
      } else {
        const pooled = await runWithKeyPoolRetries(judgeKeyPool, 5, async ({ key, label }) => {
          return chatCall({
            baseUrl: opts.judgeBaseUrl,
            apiKey: key,
            requestBody,
            timeoutMs: 60_000,
            retries: 2,
            onHttpError: (status) => judgeKeyPool.reportError(label, status),
          });
        });
        rawContent = pooled.value.body.choices?.[0]?.message?.content ?? '';
        modelEcho = pooled.value.body.model ?? opts.judgeModel;
        finishReason = pooled.value.body.choices?.[0]?.finish_reason ?? '';
        promptTokens = pooled.value.body.usage?.prompt_tokens ?? 0;
        completionTokens = pooled.value.body.usage?.completion_tokens ?? 0;
        latencyMs = pooled.value.latencyMs;

        if (evalCache && cacheKey) {
          const entry: EvalCacheEntry = {
            cacheKey,
            providerNamespace: judgeNamespace,
            callType: 'judge',
            questionId: qaItem.id,
            rawContent,
            modelEcho,
            finishReason,
            promptTokens,
            completionTokens,
            latencyMs,
            requestBody,
          };
          evalCache.put(entry);
        }
      }

      const parsed = parseNuggetScore(rawContent);
      nuggets.push({
        criterion: rubricItem,
        score: parsed.score,
        reason: parsed.reason,
        rawContent,
        parseError: parsed.parseError,
      });
      void fromCache;
    }

    results.push({
      id: qaItem.id,
      category: caseItem.category,
      question: caseItem.query,
      llmResponse,
      expectedAnswer: caseItem.expectedAnswer,
      nuggets,
      questionScore: questionScoreFromNuggets(nuggets),
    });
  })));

  results.sort((a, b) => a.id.localeCompare(b.id));
  const report = aggregateScores(results);
  const finishedAt = new Date().toISOString();
  const git = gitState(process.cwd());
  const evaluator = evaluatorSourceHash(process.cwd());

  const evalsPath = path.join(outputDir, 'nugget-evaluations.jsonl');
  await fsp.writeFile(evalsPath, results.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  await fsp.writeFile(path.join(outputDir, 'score-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  let md = `# BEAM Nugget Score Report\n\n`;
  md += `Overall Nugget Score: **${(report.overallScore * 100).toFixed(1)}%** (${report.overallScore.toFixed(3)})\n`;
  md += `Report status: **${report.valid ? 'VALID' : 'INVALID — parse failures present'}**\n`;
  md += `Evaluated Questions: ${report.totalQuestions} | Scored Questions: ${report.scoredQuestions} | Total Nuggets: ${report.totalNuggets} | Parse Failures: ${report.parseFailures}\n\n`;
  md += `## Per-Capability Breakdown\n\n`;
  md += `| Capability | Questions | Mean Nugget Score | Parse Failures |\n`;
  md += `|---|---|---|---|\n`;
  for (const [cap, data] of Object.entries(report.byCapability)) {
    md += `| ${cap} | ${data.count} | ${(data.meanScore * 100).toFixed(1)}% | ${data.parseFailures} |\n`;
  }
  await fsp.writeFile(path.join(outputDir, 'score-report.md'), md, 'utf8');

  const manifest = {
    schemaVersion: 1,
    benchmark: 'beam-nugget-score',
    metricProtocol: 'renor-beam-gemma-nugget-judge-v1-not-official',
    protocolComparableToOfficial: false,
    protocolNote: 'Uses the official BEAM rubric prompt but a Gemma judge and Renor parsing/aggregation. Do not compare this score directly with the official GPT evaluator headline.',
    judgeModel: opts.judgeModel,
    judgeBaseUrl: opts.judgeBaseUrl,
    cacheEnabled,
    cacheScope,
    routingSession,
    runClass: cacheEnabled ? 'development-replay' : 'authoritative-cold',
    startedAt,
    finishedAt,
    gitSha: git.sha,
    gitDirty: git.dirty,
    evaluatorSha256: evaluator,
    cacheStats: evalCache?.stats,
    report,
  };
  await fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  evalCache?.close();
  console.log(JSON.stringify(report, null, 2));

  assertAuthoritativeReport(report, cacheEnabled);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
