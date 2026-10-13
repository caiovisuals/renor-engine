import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  UNIFIED_LLM_JUDGE_BASE_PROMPT,
  OFFICIAL_PROMPT_SHA256,
  parseNuggetScore,
  aggregateScores,
  questionScoreFromNuggets,
  assertAuthoritativeReport,
  renderJudgePrompt,
  type QuestionNuggetResult,
} from '../../scripts/eval/beam/score-nuggets';

describe('BEAM official judge prompt', () => {
  it('is byte-identical to the official unified_llm_judge_base_prompt (sha256 pin)', () => {
    const digest = crypto.createHash('sha256').update(UNIFIED_LLM_JUDGE_BASE_PROMPT).digest('hex');
    expect(digest).toBe(OFFICIAL_PROMPT_SHA256);
    expect(UNIFIED_LLM_JUDGE_BASE_PROMPT.startsWith('\n')).toBe(true);
    expect(UNIFIED_LLM_JUDGE_BASE_PROMPT.endsWith('\n')).toBe(true);
  });

  it('substitutes rubric and response without touching the rest of the prompt', () => {
    const rendered = renderJudgePrompt('must mention March 29', 'The sprint ends March 29.');
    expect(rendered).toContain('must mention March 29');
    expect(rendered).toContain('The sprint ends March 29.');
    expect(rendered).not.toContain('<rubric_item>');
    expect(rendered).not.toContain('<llm_response>');
  });
});

describe('parseNuggetScore', () => {
  it('parses a clean JSON object', () => {
    const parsed = parseNuggetScore('{"score": 1.0, "reason": "present"}');
    expect(parsed.score).toBe(1);
    expect(parsed.reason).toBe('present');
    expect(parsed.parseError).toBeUndefined();
  });

  it('accepts 0, 0.5, and 1 only', () => {
    expect(parseNuggetScore('{"score": 0, "reason": "no"}').score).toBe(0);
    expect(parseNuggetScore('{"score": 0.5, "reason": "partial"}').score).toBe(0.5);
    expect(parseNuggetScore('{"score": 1, "reason": "yes"}').score).toBe(1);
    expect(parseNuggetScore('{"score": 0.7, "reason": "nope"}').score).toBeNull();
  });

  it('strips markdown fences', () => {
    const parsed = parseNuggetScore('```json\n{"score": 0.5, "reason": "almost"}\n```');
    expect(parsed.score).toBe(0.5);
    expect(parsed.reason).toBe('almost');
  });

  it('recovers JSON buried in prose', () => {
    const parsed = parseNuggetScore('Sure.\n{"score": 0.0, "reason": "missing"}\nThanks.');
    expect(parsed.score).toBe(0);
    expect(parsed.reason).toBe('missing');
  });

  it('records a parse failure instead of inventing a score', () => {
    const parsed = parseNuggetScore('the answer looks fine');
    expect(parsed.score).toBeNull();
    expect(parsed.parseError).toMatch(/Failed to parse score/);
  });
});

describe('aggregateScores', () => {
  const q = (id: string, category: string, nuggetScores: Array<number | null>): QuestionNuggetResult => {
    const nuggets = nuggetScores.map((score, i) => ({
      criterion: `c${i}`,
      score,
      reason: '',
      parseError: score === null ? 'fail' : undefined,
    }));
    return {
      id,
      category,
      question: id,
      llmResponse: '',
      expectedAnswer: '',
      nuggets,
      questionScore: questionScoreFromNuggets(nuggets),
    };
  };

  it('means nuggets per question, then questions per capability, then capabilities overall', () => {
    const report = aggregateScores([
      q('a1', 'abstention', [1, 1]),
      q('a2', 'abstention', [0, 0]),
      q('i1', 'information_extraction', [1, 0.5, 0.5]),
    ]);
    expect(report.byCapability.abstention.meanScore).toBe(0.5);
    expect(report.byCapability.information_extraction.meanScore).toBe(0.667);
    expect(report.overallScore).toBe(0.583);
    expect(report.totalQuestions).toBe(3);
    expect(report.totalNuggets).toBe(7);
    expect(report.parseFailures).toBe(0);
    expect(report.scoredQuestions).toBe(3);
    expect(report.valid).toBe(true);
  });

  it('invalidates a question when any nugget cannot be parsed', () => {
    const row = q('a1', 'abstention', [1, null, 0]);
    expect(row.questionScore).toBeNull();
    const report = aggregateScores([row]);
    expect(report.byCapability.abstention.count).toBe(0);
    expect(report.byCapability.abstention.meanScore).toBe(0);
    expect(report.scoredQuestions).toBe(0);
    expect(report.parseFailures).toBe(1);
    expect(report.valid).toBe(false);
    expect(report.byCapability.abstention.parseFailures).toBe(1);
    expect(() => assertAuthoritativeReport(report, false)).toThrow(/Authoritative BEAM scoring is invalid/);
    expect(() => assertAuthoritativeReport(report, true)).not.toThrow();
  });

  it('is reproducible from the same raw results', () => {
    const rows = [
      q('a1', 'summarization', [1, 0.5]),
      q('b1', 'temporal_reasoning', [0, 0, 1]),
    ];
    expect(aggregateScores(rows)).toEqual(aggregateScores(rows));
  });
});


describe('BEAM adapter pipeline regressions', () => {
  const python = (args: string[]) => {
    const run = spawnSync('python3', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    return run;
  };

  it('builds unique sessions, marks abstention, and exports official answers', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-beam-build-'));
    try {
      const chatsDir = path.join(tmp, 'chats', '100K');
      const chatDir = path.join(chatsDir, '1');
      const pqDir = path.join(chatDir, 'probing_questions');
      fs.mkdirSync(pqDir, { recursive: true });

      fs.writeFileSync(path.join(chatDir, 'chat.json'), JSON.stringify([
        {
          batch_number: 1,
          time_anchor: null,
          turns: [[
            { role: 'user', content: 'I use Flask.', time_anchor: 'March-15-2024' },
            { role: 'assistant', content: 'Noted.' },
          ]],
        },
      ]));
      fs.writeFileSync(path.join(pqDir, 'probing_questions.json'), JSON.stringify({
        abstention: [{
          question: 'What database do I use?',
          ideal_response: 'There is no information about the database.',
          difficulty: 'easy',
          rubric: ['Response should say the database is unknown'],
        }],
      }));

      const adapterOut = path.join(tmp, 'adapter');
      python([
        path.resolve(process.cwd(), 'scripts/eval/beam/build-corpus.py'),
        '--beam-chats-dir', chatsDir,
        '--output', adapterOut,
        '--scale', '100K',
      ]);

      const cases = fs.readFileSync(path.join(adapterOut, 'cases.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(cases).toHaveLength(1);
      expect(cases[0].id).toBe('beam-100k-c01-abstention-0');
      expect(cases[0].shouldAbstain).toBe(true);
      expect(cases[0].relevant[0].notePath).toBe('Sessions/conv-01-session-01.md');
      expect(fs.existsSync(path.join(adapterOut, 'corpus', 'conv-01', 'Sessions', 'conv-01-session-01.md'))).toBe(true);

      const qaPath = path.join(tmp, 'qa.jsonl');
      fs.writeFileSync(qaPath, JSON.stringify({
        id: cases[0].id,
        answer: { text: "I don't know." },
      }) + '\n');
      const officialOut = path.join(tmp, 'official');
      python([
        path.resolve(process.cwd(), 'scripts/eval/beam/export-official-answers.py'),
        '--cases', path.join(adapterOut, 'cases.jsonl'),
        '--qa', qaPath,
        '--output', officialOut,
        '--scale', '100K',
        '--name', 'renor-answers.json',
      ]);

      const exported = JSON.parse(fs.readFileSync(
        path.join(officialOut, '100K', '1', 'renor-answers.json'),
        'utf8',
      ));
      expect(exported.abstention).toEqual([{
        question: 'What database do I use?',
        llm_response: "I don't know.",
      }]);
      expect(exported.information_extraction).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('separates duplicate and unmapped session drops during assembly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-beam-assemble-'));
    try {
      const runDir = path.join(tmp, 'run');
      const outDir = path.join(tmp, 'out');
      const corpusDir = path.join(tmp, 'corpus');
      const sessionsDir = path.join(corpusDir, 'Sessions');
      fs.mkdirSync(runDir, { recursive: true });
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'conv-01-session-01.md'), '# Session one\n');

      fs.writeFileSync(path.join(runDir, 'cases.jsonl'), JSON.stringify({
        id: 'q1',
        corpusDir,
      }) + '\n');
      fs.writeFileSync(path.join(runDir, 'results.jsonl'), JSON.stringify({
        id: 'q1',
        hits: [
          { notePath: 'Sessions/conv-01-session-01-occ1.md', text: 'chunk 1', score: 0.9 },
          { notePath: 'Sessions/conv-01-session-01-occ2.md', text: 'chunk 2', score: 0.8 },
          { notePath: 'Sessions/missing-occ1.md', text: 'missing', score: 0.7 },
        ],
        latencyMs: 1,
        contextTokens: 10,
      }) + '\n');
      fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
        benchmark: 'beam-retrieval',
        corpusDirs: [corpusDir],
      }));

      python([
        path.resolve(process.cwd(), 'scripts/eval/beam/assemble-sessions.py'),
        '--run', runDir,
        '--output', outDir,
      ]);

      const perCase = JSON.parse(fs.readFileSync(path.join(outDir, 'per-case.jsonl'), 'utf8').trim());
      expect(perCase.sessionHits).toBe(1);
      expect(perCase.droppedDuplicate).toBe(1);
      expect(perCase.droppedUnmapped).toBe(1);

      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
      expect(manifest.hitsDropped).toBe(2);
      expect(manifest.hitsDroppedDuplicate).toBe(1);
      expect(manifest.hitsDroppedUnmapped).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
