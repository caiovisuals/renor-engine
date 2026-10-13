import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { roleOf, type GoldTarget } from '../../src/eval/metrics';
import type { EvalCase } from '../../src/eval/scoring';

const CASES_PATH = 'docs/evals/renorbench-v1.dev.jsonl';
const FIXTURE_DIR = 'fixtures/eval/renorbench-v1';
const MIN_PER_CATEGORY = 8;

function readCases(): EvalCase[] {
  return fs.readFileSync(path.resolve(CASES_PATH), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as EvalCase);
}

interface FixtureMeta {
  relativeMtimeDays?: Record<string, number>;
  deleteAfterIndex?: string[];
}

function readFixture(): { vaultDir: string; meta: FixtureMeta } {
  const fixtureRoot = path.resolve(FIXTURE_DIR);
  const meta = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8')) as FixtureMeta;
  return { vaultDir: path.join(fixtureRoot, 'vault'), meta };
}

function noteText(vaultDir: string, notePath: string): string {
  return fs.readFileSync(path.join(vaultDir, notePath), 'utf8');
}

function allTargets(test: EvalCase): { field: string; target: GoldTarget }[] {
  return [
    ...test.relevant.map(target => ({ field: 'relevant', target })),
    ...(test.requiredEvidence ?? []).map(target => ({ field: 'requiredEvidence', target })),
    ...(test.forbiddenEvidence ?? []).map(target => ({ field: 'forbiddenEvidence', target })),
  ];
}

describe('renorbench-v1 dev benchmark integrity', () => {
  const cases = readCases();
  const { vaultDir, meta } = readFixture();
  const deleted = new Set(meta.deleteAfterIndex ?? []);

  it('has unique case ids', () => {
    const ids = cases.map(test => test.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('meets the minimum floor for every category', () => {
    const counts = new Map<string, number>();
    for (const test of cases) counts.set(test.category, (counts.get(test.category) ?? 0) + 1);
    for (const [category, count] of counts) {
      expect(count, `category ${category}`).toBeGreaterThanOrEqual(MIN_PER_CATEGORY);
    }
    expect(cases.length).toBeGreaterThanOrEqual(180);
  });

  it('pins every gold target to a note that exists in the vault', () => {
    for (const test of cases) {
      for (const { field, target } of allTargets(test)) {
        expect(
          target.notePath,
          `${test.id}.${field} target "${target.match}" must be path-pinned`,
        ).toBeDefined();
        const exists = fs.existsSync(path.join(vaultDir, target.notePath!));
        if (deleted.has(target.notePath!)) {
          // Pinned to a deleted note: only forbidden evidence may live there.
          expect(field, `${test.id}.${field} may not reference a deleted note`).toBe('forbiddenEvidence');
        } else {
          expect(exists, `${test.id}.${field} pin ${target.notePath} missing from vault`).toBe(true);
        }
      }
    }
  });

  it('every needle occurs in the text of its pinned note', () => {
    for (const test of cases) {
      for (const { field, target } of allTargets(test)) {
        const needle = target.match.trim().toLowerCase();
        const text = noteText(vaultDir, target.notePath!);
        const inText = text.toLowerCase().includes(needle);
        const inPath = target.notePath!.toLowerCase().includes(needle);
        expect(
          inText || inPath,
          `${test.id}.${field} needle "${target.match}" not found in ${target.notePath}`,
        ).toBe(true);
      }
    }
  });

  it('forbidden evidence never shares a note with the positive evidence of the same case', () => {
    // Otherwise contradiction-first detection is structurally impossible.
    for (const test of cases) {
      const positivePaths = new Set(
        test.relevant.filter(target => roleOf(target) !== 'forbidden').map(target => target.notePath),
      );
      for (const target of test.forbiddenEvidence ?? []) {
        expect(
          positivePaths.has(target.notePath),
          `${test.id} forbids "${target.match}" in ${target.notePath}, which is also positive evidence`,
        ).toBe(false);
      }
    }
  });

  it('answerable cases always carry at least one positive-role target', () => {
    for (const test of cases) {
      if (test.shouldAbstain || test.relevant.length === 0) continue;
      expect(
        test.relevant.some(target => roleOf(target) === 'positive'),
        `${test.id} has no creditable gold`,
      ).toBe(true);
    }
  });

  it('multi-hop cases require evidence spanning at least two distinct notes', () => {
    for (const test of cases) {
      if (test.category !== 'multi_hop') continue;
      const paths = new Set((test.requiredEvidence ?? []).map(target => target.notePath));
      expect(paths.size, `${test.id} multi-hop must span >= 2 notes`).toBeGreaterThanOrEqual(2);
    }
  });

  it('records mtimes for every vault note and only for existing notes', () => {
    const mtimes = new Set(Object.keys(meta.relativeMtimeDays ?? {}));
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [path.relative(vaultDir, full).replaceAll(path.sep, '/')];
      });
    const notes = walk(vaultDir);
    for (const note of notes) {
      expect(mtimes.has(note), `fixture.json missing mtime for ${note}`).toBe(true);
    }
    for (const key of mtimes) {
      expect(fs.existsSync(path.join(vaultDir, key)), `fixture.json mtime for missing note ${key}`).toBe(true);
    }
  });

  it('deletion cases only pin forbidden evidence to notes scheduled for deletion', () => {
    for (const test of cases) {
      if (test.category !== 'deletion_erasure') continue;
      expect(test.shouldAbstain).toBe(true);
      expect(test.relevant).toEqual([]);
      for (const target of test.forbiddenEvidence ?? []) {
        expect(deleted.has(target.notePath!), `${test.id} pins erasure gold to a live note`).toBe(true);
      }
    }
  });
});