import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  EVALUATOR_SOURCES,
  evaluatorSourceHash,
  gitState,
  packageLockSha256,
} from '../../src/eval/runManifest';

function tempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-runmanifest-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

describe('evaluator freeze manifest', () => {
  it('EVALUATOR_SOURCES excludes product retrieval code', () => {
    const joined = EVALUATOR_SOURCES.join('\n');
    expect(joined).toContain('src/eval/metrics.ts');
    expect(joined).toContain('scripts/eval/compare-runs.ts');
    expect(joined).not.toContain('src/retrieval/');
    expect(joined).not.toContain('src/indexer/');
    expect(joined).not.toContain('src/embeddings/');
  });

  it('evaluatorSourceHash is stable for identical content and changes when scoring changes', () => {
    const files = Object.fromEntries(
      EVALUATOR_SOURCES.map(relative => [relative, `// placeholder for ${relative}\n`]),
    );
    const dirA = tempRepo(files);
    const dirB = tempRepo(files);
    expect(evaluatorSourceHash(dirA)).toBe(evaluatorSourceHash(dirB));

    // Simulate a candidate tampering with the metric implementation.
    fs.writeFileSync(path.join(dirB, 'src/eval/metrics.ts'), '// tampered\n', 'utf8');
    expect(evaluatorSourceHash(dirA)).not.toBe(evaluatorSourceHash(dirB));

    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('evaluatorSourceHash throws when an evaluator source is missing', () => {
    const dir = tempRepo({ 'src/eval/metrics.ts': 'x' });
    expect(() => evaluatorSourceHash(dir)).toThrow(/Evaluator source missing/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gitState reports clean and dirty trees', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-gitstate-'));
    const env = { ...process.env };
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, env });
      execFileSync('git', ['config', 'user.email', 'eval@example.com'], { cwd: dir, env });
      execFileSync('git', ['config', 'user.name', 'Eval Test'], { cwd: dir, env });
      execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: dir, env });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'initial\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: dir, env });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });

      const clean = gitState(dir);
      expect(clean.dirty).toBe(false);
      expect(clean.statusSha256).toBeNull();
      expect(clean.sha).toMatch(/^[0-9a-f]{40}$/);

      fs.writeFileSync(path.join(dir, 'a.txt'), 'modified\n', 'utf8');
      const dirty = gitState(dir);
      expect(dirty.dirty).toBe(true);
      expect(dirty.statusSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(dirty.sha).toBe(clean.sha);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packageLockSha256 returns null when absent and a hash when present', () => {
    const empty = tempRepo({});
    expect(packageLockSha256(empty)).toBeNull();
    fs.writeFileSync(path.join(empty, 'package-lock.json'), '{}\n', 'utf8');
    expect(packageLockSha256(empty)).toMatch(/^[0-9a-f]{64}$/);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});