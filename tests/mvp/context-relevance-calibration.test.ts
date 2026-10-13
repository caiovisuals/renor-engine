import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { indexVault } from '../../src/indexer/pipeline';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { EvalHashEmbeddingProvider } from '../../src/eval/hashEmbedding';
import { CALIBRATED_BARS, CONTEXT_RELEVANCE_DEFAULT_ON, UNKNOWN_NAME_MARGIN, combineSimilarity, requestNames } from '../../src/mvp/contextRelevance';
import { nameOnFile } from '../../src/mvp/agentMemory';
import {
  FALSE_ABSTENTION_CEILING,
  FLAGGED_FLOOR,
  RECORDED_FILE,
  assertSeeded,
  confusion,
  devBarInterval,
  fixtureHash,
  lexicalConfusion,
  loadQuestions,
  loadWorkspace,
  meetsBar,
  meetsShipCriterion,
  rowsFor,
  seedWorkspace,
  type RecordedCalibration,
  type RecordedResult,
  type Split,
  type WorkspaceName,
  type WorkspaceSize,
} from '../../scripts/eval/relevance-calibration';

/**
 * Replays the recorded Vertex gemini-embedding-001 (768) calibration of the relevance signal.
 * No network, no credentials: the file holds the similarities the product computed on the fixture
 * workspaces (scripts/eval/relevance-calibration.ts), and these tests re-derive every reported number
 * from it. Method, pre-registration and discussion: docs/evals/results/RELEVANCE-SIGNAL-20261002.md.
 */

const MODEL_KEY = 'vertex:gemini-embedding-001:768';
const BAR = CALIBRATED_BARS[MODEL_KEY];
const recorded = JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8')) as RecordedCalibration;
const SPLITS: Split[] = ['dev', 'heldout'];
const SIZES: WorkspaceSize[] = ['small', 'large'];

const round3 = (n: number) => Math.round(n * 1000) / 1000;

describe('the recording', () => {
  it('is of these fixtures and this embedding model', () => {
    expect(recorded.modelKey).toBe(MODEL_KEY);
    expect(recorded.fixtureHash, 'fixtures changed: re-run scripts/eval/relevance-calibration.ts --write').toBe(fixtureHash());
  });

  it('answers every question at both workspace sizes, and the similarity is the product\'s combination of the two lanes', () => {
    for (const split of SPLITS) {
      const questions = loadQuestions(split);
      for (const size of SIZES) {
        const rows = recorded.results.filter(r => r.split === split && r.size === size);
        expect(rows.map(r => r.id).sort()).toEqual(questions.map(q => q.id).sort());
        for (const r of rows) {
          const expected = combineSimilarity(r.chunk, r.fact);
          expect(r.similarity).toBe(expected === null ? null : round3(expected));
        }
      }
    }
  });
});

describe('the calibration set', () => {
  it('is at least 60 questions and covers paraphrases, partial matches, short and non-English questions, and unanswerable ones', () => {
    for (const split of SPLITS) {
      const qs = loadQuestions(split);
      expect(qs.length).toBeGreaterThanOrEqual(60);
      const answerable = new Set(qs.filter(q => q.expect === 'answerable').map(q => q.category));
      for (const category of ['direct', 'paraphrase', 'partial', 'short', 'non-english', 'note']) expect(answerable.has(category)).toBe(true);
      expect(qs.filter(q => q.expect === 'unanswerable').length).toBeGreaterThanOrEqual(20);
      expect(new Set(qs.filter(q => q.lang !== 'en').map(q => q.lang)).size).toBeGreaterThanOrEqual(3);
    }
    const ids = [...loadQuestions('dev'), ...loadQuestions('heldout')].map(q => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds the workspaces the questions are asked against: every fixture fact is current and every note is indexed, at both sizes', async () => {
    const provider = new EvalHashEmbeddingProvider();
    for (const name of ['a', 'b', 'c'] as WorkspaceName[]) {
      for (const size of SIZES) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-seed-'));
        try {
          const memoryDir = path.join(root, 'memory');
          fs.mkdirSync(memoryDir);
          const db = openDb(path.join(root, 'index.db'));
          runMigrations(db);
          const vectorIndex = new VectorIndex(db, provider.dimensions);
          vectorIndex.initTable();
          const ws = loadWorkspace(name, size);
          await seedWorkspace(db, memoryDir, ws);
          await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 4);
          assertSeeded(db, ws, `${name}/${size}`);
          db.close();
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);
});

describe('the chosen bar', () => {
  it('lies inside the interval where both dev sizes meet the bar, at the cautious end of its midpoint', () => {
    const interval = devBarInterval(recorded)!;
    // Exact 0.01 steps give [0.62, 0.65]. The pre-registration wrote [0.62, 0.64] (a floating-point
    // slip in the exploratory sweep that picked it) and froze 0.63; see the erratum in the results doc.
    expect(interval.low).toBe(0.62);
    expect(interval.high).toBe(0.65);
    expect(interval.midpoint).toBeCloseTo(0.635, 10);
    expect(BAR).toBe(0.63);
    expect(BAR).toBeGreaterThanOrEqual(interval.low);
    expect(BAR).toBeLessThanOrEqual(interval.midpoint);
  });
});

/** The numbers quoted in docs/evals/results/RELEVANCE-SIGNAL-20261002.md and the PR. */
const REPORTED: Record<string, { answerable: number; falseAbstain: number; unanswerable: number; flagged: number }> = {
  'dev/small': { answerable: 45, falseAbstain: 0, unanswerable: 31, flagged: 20 },
  'dev/large': { answerable: 45, falseAbstain: 0, unanswerable: 31, flagged: 19 },
  'heldout/small': { answerable: 91, falseAbstain: 0, unanswerable: 45, flagged: 26 },
  'heldout/large': { answerable: 91, falseAbstain: 0, unanswerable: 45, flagged: 24 },
};

/** The lexical RENOR_READ_HONESTY abstention (what #276 removed) on the same questions: the reference row. */
const REPORTED_LEXICAL: Record<string, { falseAbstain: number; flagged: number }> = {
  'dev/small': { falseAbstain: 15, flagged: 20 },
  'dev/large': { falseAbstain: 18, flagged: 17 },
  'heldout/small': { falseAbstain: 29, flagged: 29 },
  'heldout/large': { falseAbstain: 39, flagged: 25 },
};

describe('the confusion matrices at the shipped bar', () => {
  for (const [key, expected] of Object.entries(REPORTED)) {
    it(`${key} matches the reported numbers`, () => {
      const [split, size] = key.split('/') as [Split, WorkspaceSize];
      const c = confusion(rowsFor(recorded, split, size), BAR);
      expect({ answerable: c.answerable, falseAbstain: c.fn, unanswerable: c.unanswerable, flagged: c.tn }).toEqual(expected);
    });
  }

  for (const [key, expected] of Object.entries(REPORTED_LEXICAL)) {
    it(`${key}: the lexical abstention it replaces false-abstains far more often`, () => {
      const [split, size] = key.split('/') as [Split, WorkspaceSize];
      const lexical = lexicalConfusion(rowsFor(recorded, split, size));
      expect({ falseAbstain: lexical.fn, flagged: lexical.tn }).toEqual(expected);
      const ours = confusion(rowsFor(recorded, split, size), BAR);
      expect(lexical.falseAbstentionRate).toBeGreaterThan(0.3);
      expect(ours.falseAbstentionRate).toBeLessThan(FALSE_ABSTENTION_CEILING);
    });
  }

  it('ships on by default if and only if the held-out run met the pre-registered criterion', () => {
    expect(FALSE_ABSTENTION_CEILING).toBe(0.05);
    expect(FLAGGED_FLOOR).toBe(0.5);
    const met = SIZES.every(size => meetsBar(confusion(rowsFor(recorded, 'heldout', size), BAR)));
    expect(meetsShipCriterion(recorded, BAR)).toBe(met);
    expect(CONTEXT_RELEVANCE_DEFAULT_ON).toBe(met);
  });
});

describe('an unknown name raises the bar (UNKNOWN_NAME_MARGIN), replayed on the recording', () => {
  it('flags the same questions at the shipped bar: no answerable question lost, every flag kept', async () => {
    // The product's own name check over each fixture workspace (indexed with the lexical stub: it reads words, not
    // vectors), applied to the recorded similarities exactly as assessQueryRelevance applies it.
    const provider = new EvalHashEmbeddingProvider();
    const raised = Math.round((BAR + UNKNOWN_NAME_MARGIN) * 1000) / 1000;
    const questions = new Map(SPLITS.flatMap(split => loadQuestions(split).map(q => [`${split}/${q.id}`, q] as const)));
    const replayed: RecordedResult[] = [];
    let raisedFor = 0;
    for (const name of ['a', 'b', 'c'] as WorkspaceName[]) {
      for (const size of SIZES) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-names-'));
        try {
          const memoryDir = path.join(root, 'memory');
          fs.mkdirSync(memoryDir);
          const db = openDb(path.join(root, 'index.db'));
          runMigrations(db);
          const vectorIndex = new VectorIndex(db, provider.dimensions);
          vectorIndex.initTable();
          await seedWorkspace(db, memoryDir, loadWorkspace(name, size));
          await indexVault(db, memoryDir, { embeddingProvider: provider, vectorIndex }, 4);
          const onFile = nameOnFile(db, memoryDir);
          for (const r of recorded.results.filter(x => x.workspace === name && x.size === size)) {
            const q = questions.get(`${r.split}/${r.id}`)!;
            const gray = r.similarity !== null && r.similarity >= BAR && r.similarity < raised;
            const unknown = gray && requestNames(q.q).some(n => !onFile(n));
            if (unknown) raisedFor++;
            replayed.push(unknown ? { ...r, similarity: -1 } : r);
          }
          db.close();
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    }
    const shipped = { ...recorded, results: replayed };
    for (const [key, expected] of Object.entries(REPORTED)) {
      const [split, size] = key.split('/') as [Split, WorkspaceSize];
      const c = confusion(rowsFor(shipped, split, size), BAR);
      expect({ answerable: c.answerable, falseAbstain: c.fn, unanswerable: c.unanswerable, flagged: c.tn }, key).toEqual(expected);
    }
    expect(meetsShipCriterion(shipped, BAR)).toBe(true);
    expect(raisedFor).toBe(0); // no question of the calibration names something unknown with a match in the margin
  }, 120_000);
});
