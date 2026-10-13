#!/usr/bin/env node
/**
 * DIAGNOSTIC (zero live model calls): why cross-run eval-cache replay fails.
 *
 * Reproduces ONE benchmark case's answer/judge request bodies TWICE through the
 * real runner assembly path (renderSession → temp vault → index via eval-hash →
 * cliPublicSearch → hit relativization → assembleClientContext) with two
 * DIFFERENT per-case temp dirs, then byte-diffs the two request bodies.
 *
 * Evidence isolation:
 *  - Embeddings: eval-hash (deterministic, no provider).
 *  - Baseline body byte-diff runs with RENOR_SEARCH_EVIDENCE=0: the CLI
 *    subprocess inherits no live extractor path (kill switch restores the
 *    pre-ship behavior byte-for-byte, src/evidence/attach.ts).
 *  - The evidence path is probed separately, in-process and zero-live: the
 *    exact extractor prompt is rendered via the REAL
 *    loadEvidenceSessionsFromVault + renderEvidencePrompt on both temp vaults.
 *    Byte-identical prompts ⇒ the content-addressed evidence cache
 *    (key = sha256(schema\0model\0prompt)) replays identical tables across
 *    runs. renderEvidenceTable (src/evidence/attach.ts) renders
 *    item/action/amount/date only — vault paths cannot enter the table.
 *  - Therefore any byte difference between the two runs is attributable to
 *    per-run state, expected: the mkdtemp path tokens.
 *  - NOTE: this diagnostic must be run with provider keys scrubbed from the
 *    environment (env -u OLLAMA_CLOUD_KEY_1..3 -u OLLAMA_API_KEY); the
 *    baseline probe itself is key-independent (evidence off).
 *
 * Run: mise exec node -- npx tsx scripts/eval/diagnose-evalcache-path-variance.ts
 * Exit 0 = only path-variance found (or no difference at all).
 * Exit 1 = NON-path semantic differences found — do NOT canonicalize keys.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assembleClientContext,
  cliPublicSearch,
  vaultRelativeNotePath,
  writeQuestionVault,
} from './run-longmemeval-product';
import { loadEvidenceSessionsFromVault, renderEvidencePrompt } from '../../src/evidence/secondPass';
import type { LongMemInstance } from '../../src/eval/longmemeval';

// The runner's per-case answer/judge prompt constants, byte-copied from
// scripts/eval/run-longmemeval-product.ts (module-private consts).
const ANSWER_SYSTEM_PROMPT = 'You are a helpful assistant answering questions using provided conversation memory excerpts.';
const DIRECT_INSTRUCTION = 'Answer the question directly and concisely based on the excerpts above. Do not add caveats or explanations. If the excerpts do not contain the information needed to answer, reply exactly: I don\'t know.';
const answerUserPrompt = (questionDate: string, question: string, context: string) => `Conversation memory excerpts (retrieved from long-term memory, highest relevance first):\n\n${context}\n\nQuestion (asked on ${questionDate}): ${question}\n\n${DIRECT_INSTRUCTION}`;
const JUDGE_SYSTEM_PROMPT = 'You are an impartial judge evaluating whether an AI assistant\'s answer is correct.';
const judgeUserPrompt = (question: string, gold: string, answer: string) => `Question: ${question}\n\nGround truth answer: ${gold}\n\nAssistant's answer: ${answer}\n\nDoes the assistant's answer agree with the ground truth in substance (correct fact, person, value, or the required "I don't know")? Respond with ONLY the single digit 1 if correct, or 0 if incorrect, incomplete, or evasive. Output nothing else.`;

const TEMP_DIR_RE = /\/tmp\/renor-product-[A-Za-z0-9]{6}\/vault?/g;
const TEMP_DIR_BARE_RE = /\/tmp\/renor-product-[A-Za-z0-9]{6}/g;

/** Longest common prefix/suffix diff — shows the exact differing middle regions. */
function byteDiffRegions(a: string, b: string, label: string): { pathVarianceOnly: boolean; regions: string[] } {
  if (a === b) return { pathVarianceOnly: true, regions: [] };
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const pathOnly = (s: string) => s.replaceAll(TEMP_DIR_RE, '<TEMP>').replaceAll(TEMP_DIR_BARE_RE, '<TEMP>');
  const regions = [
    `${label}: differing region length A=${midA.length} B=${midB.length}`,
    `  A: ${JSON.stringify(midA.slice(0, 400))}`,
    `  B: ${JSON.stringify(midB.slice(0, 400))}`,
    `  path-canonicalized equal: ${pathOnly(midA) === pathOnly(midB)}`,
  ];
  return { pathVarianceOnly: pathOnly(midA) === pathOnly(midB), regions };
}

function scanForTempTokens(s: string): string[] {
  return [...s.matchAll(TEMP_DIR_BARE_RE)].map(m => m[0]);
}

async function assembleOnce(row: LongMemInstance, model: string): Promise<{
  answerBody: string; judgeBody: string; hitsJson: string; context: string;
  evidencePrompt: string;
  workDir: string; notePaths: string[];
}> {
  // EXACTLY the runner's per-case temp-dir pattern (scripts/eval/run-longmemeval-product.ts).
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-product-'));
  const query = `Question date: ${row.question_date}\n${row.question}`;
  const rendered = await writeQuestionVault(workDir, row);
  const dbPath = path.join(workDir, 'product.db');
  const spawnEnv: Record<string, string> = {
    VAULT_PATH: rendered.vaultDir,
    DB_PATH: dbPath,
    EMBEDDING_PROVIDER: 'eval-hash',
    LLM_EXTRACTION: 'false',
    INDEX_CONCURRENCY: '4',
    // Evidence OFF for the baseline byte-diff: isolate per-run state on the pure
    // retrieval path. The evidence path is probed separately (in-process, via
    // the real loadEvidenceSessionsFromVault + renderEvidencePrompt) so the
    // diagnostic never makes a live extraction call.
    RENOR_SEARCH_EVIDENCE: '0',
  };
  const publicResult = await cliPublicSearch({
    query, vaultDir: rendered.vaultDir, dbPath, env: spawnEnv, topK: 20, cwd: process.cwd(),
  });
  // In-process evidence probe (zero live calls): hydrate sessions through the
  // REAL product selection and render the EXACT extractor prompt. If the prompt
  // bytes match across temp dirs, the content-addressed evidence cache
  // (key = sha256(schema\0model\0prompt)) guarantees identical evidence tables
  // on a shared RENOR_EVIDENCE_CACHE — no path variance can enter evidence.
  const evidenceSessions = await loadEvidenceSessionsFromVault(publicResult.hits, rendered.vaultDir, {});
  const evidencePrompt = renderEvidencePrompt(query, evidenceSessions);
  const hits = publicResult.hits.map(hit => ({ ...hit, notePath: vaultRelativeNotePath(rendered.vaultDir, hit.notePath) }));
  const assembled = assembleClientContext(hits, 6000, { contextDates: true });
  const questionDate = query.match(/^Question date: (.*)\n/)?.[1] ?? '';
  const answerBody = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      { role: 'user', content: answerUserPrompt(questionDate, row.question, assembled.context) },
    ],
    temperature: 0,
  });
  const judgeBody = JSON.stringify({
    model: 'stub-judge',
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: judgeUserPrompt(row.question, 'stub-gold-answer', 'stub assistant answer') },
    ],
    temperature: 0,
  });
  return {
    answerBody, judgeBody,
    hitsJson: JSON.stringify(hits),
    context: assembled.context,
    evidencePrompt,
    workDir,
    notePaths: hits.map(h => h.notePath),
  };
}

export async function runDiagnostic(): Promise<{ exitCode: number; report: string }> {
  // Synthetic LongMemEval-shaped case (gold fields never enter the product
  // process; the answer/judge bodies here use stubs for judge-only fields).
  const row = {
    question_id: 'q_diag_pathvariance_1',
    question_type: 'single_session_user',
    question: 'What does Alex drink in the morning, and how much does the gym membership cost?',
    answer: 'mango juice; $40',
    question_date: '2026/02/01 (Sun) 09:00',
    haystack_session_ids: ['sess-1', 'noise-1', 'noise-2', 'noise-3'],
    haystack_dates: [
      '2026/01/01 (Thu) 10:00', '2025/12/01 (Mon) 09:00',
      '2025/11/01 (Sat) 09:00', '2025/10/01 (Wed) 09:00',
    ],
    haystack_sessions: [
      [
        { role: 'user', content: 'Alex drinks mango juice every morning.' },
        { role: 'assistant', content: 'Noted.' },
      ],
      [{ role: 'user', content: 'Completely unrelated noise content one for retrieval contrast.' }],
      [{ role: 'user', content: 'Completely unrelated noise content two for retrieval contrast.' }],
      [{ role: 'user', content: 'Completely unrelated noise content three for retrieval contrast.' }],
    ],
    answer_session_ids: ['sess-1'],
  } as unknown as LongMemInstance;

  const runs = [await assembleOnce(row, 'stub-answer'), await assembleOnce(row, 'stub-answer')];
  const reportLines: string[] = [];
  let allPathOnly = true;

  const pairs: Array<[string, string, string]> = [
    ['hits JSON (relativized)', runs[0].hitsJson, runs[1].hitsJson],
    ['assembled context', runs[0].context, runs[1].context],
    ['answer request body', runs[0].answerBody, runs[1].answerBody],
    ['judge request body', runs[0].judgeBody, runs[1].judgeBody],
    ['evidence extractor prompt (evidence-cache key input)', runs[0].evidencePrompt, runs[1].evidencePrompt],
  ];
  reportLines.push(`temp dirs: ${runs[0].workDir} vs ${runs[1].workDir}`);
  reportLines.push(`note paths (run 1, relativized): ${JSON.stringify(runs[0].notePaths)}`);
  for (const [label, a, b] of pairs) {
    if (a === b) {
      reportLines.push(`BYTE-IDENTICAL: ${label}`);
      continue;
    }
    const diff = byteDiffRegions(a, b, label);
    reportLines.push(...diff.regions);
    if (!diff.pathVarianceOnly) allPathOnly = false;
  }
  const tokenHits = [runs[0].answerBody, runs[1].answerBody, runs[0].context, runs[1].context, runs[0].evidencePrompt, runs[1].evidencePrompt]
    .flatMap(scanForTempTokens);
  reportLines.push(`temp-path tokens found in bodies/context: ${tokenHits.length === 0 ? 'NONE' : JSON.stringify([...new Set(tokenHits)])}`);
  reportLines.push(allPathOnly
    ? 'VERDICT: all differences are temp-path variance (or none) — canonicalization is safe at the key level.'
    : 'VERDICT: NON-PATH SEMANTIC DIFFERENCES FOUND — STOP, do not canonicalize keys.');

  for (const run of runs) {
    await fsp.rm(run.workDir, { recursive: true, force: true });
  }
  return { exitCode: allPathOnly ? 0 : 1, report: reportLines.join('\n') };
}
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  runDiagnostic().then(({ exitCode, report }) => {
    console.log(report);
    process.exitCode = exitCode;
  }).catch(err => {
    console.error('diagnostic failed:', err);
    process.exitCode = 2;
  });
}
