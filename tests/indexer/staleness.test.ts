import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { checkVaultStaleness, stalenessGate, stalenessJsonField, stalenessMode } from '../../src/indexer/staleness';
import { tmpPath } from '../helpers/tmpPath';

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.md'), '# a\n');
  execFileSync('git', ['add', 'a.md'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

/** Amend that single commit so HEAD is `days` old (author and committer date). */
function makeHeadOld(dir: string, days: number): void {
  const ts = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
  execFileSync('git', ['commit', '--amend', '-qm', 'init', '--date', String(ts)], { cwd: dir });
  execFileSync('git', ['commit', '--amend', '-qm', 'init', '--date', String(ts)], {
    cwd: dir,
    env: { ...process.env, GIT_COMMITTER_DATE: new Date(ts * 1000).toUTCString() },
  });
}

describe('checkVaultStaleness', () => {
  it('plain dir (no .git) is never stale', () => {
    const dir = tmpPath('plain');
    fs.mkdirSync(dir, { recursive: true });
    const r = checkVaultStaleness(dir);
    expect(r.stale).toBe(false);
    expect(r.kind).toBe('plain');
    expect(r.reasons).toEqual([]);
    // In no work tree at all is the ONLY thing that reads as plain — not "no .git here".
    expect(r.repoRoot).toBeUndefined();
  });

  /**
   * CATCHES: a vault that is a SUBDIRECTORY of a work tree being answered "plain, never
   * stale". `kind` used to be decided by `fs.existsSync(vaultPath/.git)` alone, so a vault
   * inside a project repo — an ordinary layout — was never judged at all: measured on a
   * 28-day-old repository, its root reported `{stale:true, kind:'git'}` while `<root>/notes`
   * reported `{stale:false, kind:'plain'}`. That is the stale-checkout failure this guard
   * exists to catch, with its alarm silenced.
   *
   * Hermetic on purpose: a throwaway repository under this test's own temp root, never
   * `engine/fixtures/vault`, whose verdict would otherwise depend on how old the host checkout
   * happens to be and how far its branch sits behind its upstream. A nested vault is judged by
   * the SAME checkout-level signals as a root one, so two vaults in one repo cannot disagree.
   */
  it('a vault that is a SUBDIRECTORY of a work tree is judged, not treated as plain', () => {
    const repo = path.join(tmpPath('nested'), 'repo');
    initRepo(repo);
    makeHeadOld(repo, 12);
    const vault = path.join(repo, 'notes');
    fs.mkdirSync(vault, { recursive: true });
    const r = checkVaultStaleness(vault);
    expect(r.kind).toBe('git');
    expect(r.repoRoot).toBe(repo); // attributable to the checkout that was judged
    expect(r.stale).toBe(true);
    expect(r.headAgeDays).toBeGreaterThan(3);
    expect(r.reasons.some((x) => x.includes('HEAD commit is'))).toBe(true);
    // The reason names the checkout that was judged, so a banner — or a fatal refusal, which
    // exits before anything else is printed — says WHICH repository is behind instead of
    // reading as the vault's own.
    expect(r.reasons.some((x) => x.includes(`enclosing checkout ${repo}`))).toBe(true);
  });

  it('a nested vault is not stale on a FRESH enclosing checkout (no false alarm)', () => {
    const repo = path.join(tmpPath('nested-fresh'), 'repo');
    initRepo(repo);
    const vault = path.join(repo, 'notes');
    fs.mkdirSync(vault, { recursive: true });
    const r = checkVaultStaleness(vault);
    expect(r.kind).toBe('git');
    expect(r.repoRoot).toBe(repo);
    expect(r.stale).toBe(false);
  });

  it('a work-tree ROOT still reports repoRoot = vaultPath (the nested rule does not change it)', () => {
    const dir = path.join(tmpPath('root'), 'repo');
    initRepo(dir);
    const r = checkVaultStaleness(dir);
    expect(r.kind).toBe('git');
    expect(r.repoRoot).toBe(dir);
  });

  it('fresh checkout with no upstream and a recent commit is NOT stale', () => {
    const dir = path.join(tmpPath('fresh'), 'fresh');
    initRepo(dir);
    const r = checkVaultStaleness(dir);
    expect(r.kind).toBe('git');
    expect(r.stale).toBe(false);
    expect(r.headAgeDays).toBeDefined();
    expect(r.headAgeDays!).toBeLessThan(3);
  });

  it('D1 signal: old HEAD commit fires the age reason', () => {
    const dir = path.join(tmpPath('old'), 'old');
    initRepo(dir);
    // Backdate the sole commit by 12 days, exactly the D1 shape.
    const ts = Math.floor((Date.now() - 12 * 24 * 3600 * 1000) / 1000);
    execFileSync('git', ['commit', '--amend', '-qm', 'init', '--date', String(ts)], { cwd: dir });
    // GIT_COMMITTER_DATE so the amend does not refresh the committer timestamp.
    execFileSync('git', ['commit', '--amend', '-qm', 'init', '--date', String(ts)], {
      cwd: dir,
      env: { ...process.env, GIT_COMMITTER_DATE: `${new Date(ts * 1000).toUTCString()}` },
    });
    const r = checkVaultStaleness(dir);
    expect(r.stale).toBe(true);
    expect(r.headAgeDays!).toBeGreaterThan(3);
    expect(r.reasons.some((x) => x.includes('12d old'))).toBe(true);
  });

  it('D1 signal: behind the local upstream ref fires the behind reason (no network, no push)', () => {
    const clone = path.join(tmpPath('clone'), 'clone');
    initRepo(clone);
    // Second commit on HEAD; then point the LOCAL remote-tracking ref at it,
    // and roll HEAD back — the exact shape of "behind the already-fetched
    // upstream" with zero push (the host pre-push hook correctly forbids
    // pushing to main even inside a fixture, so we never push).
    fs.writeFileSync(path.join(clone, 'b.md'), '# b\n');
    execFileSync('git', ['add', 'b.md'], { cwd: clone });
    execFileSync('git', ['commit', '-qm', 'second'], { cwd: clone });
    const second = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone }).toString().trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: clone }).toString().trim();
    execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, second], { cwd: clone });
    execFileSync('git', ['update-ref', `refs/heads/${branch}`, 'HEAD~1'], { cwd: clone });
    execFileSync('git', ['config', `branch.${branch}.remote`, 'origin'], { cwd: clone });
    execFileSync('git', ['config', `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd: clone });
    const r = checkVaultStaleness(clone);
    expect(r.stale).toBe(true);
    expect(r.behind).toBe(1);
    expect(r.reasons.some((x) => x.includes('1 commit(s) behind'))).toBe(true);
  });

  it('broken git dir does not guess and does not alarm', () => {
    const dir = path.join(tmpPath('broken'), 'broken');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const r = checkVaultStaleness(dir);
    expect(r.stale).toBe(false);
    expect(r.kind).toBe('git');
    expect(r.head).toBeUndefined();
  });
});

describe('stalenessGate', () => {
  it('default mode is warn and warn never sets fatal', () => {
    expect(stalenessMode()).toBe('warn');
    const dir = path.join(tmpPath('gate-warn'), 'gate-warn');
    initRepo(dir);
    const a = stalenessGate(dir, { mode: 'warn' });
    expect(a.fatal).toBe(false);
    expect(a.stderrLines).toEqual([]);
  });

  /**
   * REWRITTEN for the narrowed contract (decision A), not loosened. This test used to assert
   * `fatal === true` for an AGE-only stale tree — exactly the outage the narrowing removes: age
   * is a heuristic about activity, not proof the content is outdated, so it must never refuse
   * service. It stays authoritative as a WARNING: the verdict is still measured, the banner is
   * still rendered, and the armed JSON field still carries it.
   */
  it('age-only staleness renders stderr but is NOT fatal: the age signal is advisory', () => {
    const dir = path.join(tmpPath('gate-fatal'), 'gate-fatal');
    initRepo(dir);
    const ts = Math.floor((Date.now() - 12 * 24 * 3600 * 1000) / 1000);
    execFileSync('git', ['commit', '--amend', '-qm', 'init', '--date', String(ts)], { cwd: dir });
    execFileSync('git', ['commit', '--amend', '-qm', 'init', '--date', String(ts)], {
      cwd: dir,
      env: { ...process.env, GIT_COMMITTER_DATE: `${new Date(ts * 1000).toUTCString()}` },
    });
    const a = stalenessGate(dir, { mode: 'fatal' });
    expect(a.fatal).toBe(false); // never an outage on age alone
    expect(a.staleness.stale).toBe(true); // the verdict is still measured
    expect(a.staleness.behind ?? 0).toBe(0); // and there is no hard evidence
    expect(a.stderrLines.length).toBeGreaterThan(0);
    expect(a.stderrLines.some((l) => l.includes('VAULT STALE'))).toBe(true);
    // The banner must not tell an operator already in fatal mode to arm fatal.
    expect(a.stderrLines.some((l) => l.includes('ADVISORY'))).toBe(true);
    // Armed JSON field intact: the client still sees the age-only verdict.
    expect(Object.keys(stalenessJsonField(a.staleness, { mode: 'fatal', armed: true }))).toEqual(['vaultStaleness']);
  });

  it('off mode mutes everything even when stale', () => {
    const dir = path.join(tmpPath('gate-off'), 'gate-off');
    initRepo(dir);
    const ts = Math.floor((Date.now() - 12 * 24 * 3600 * 1000) / 1000);
    execFileSync('git', ['commit', '--amend', '-qm', 'init', '--date', String(ts)], { cwd: dir });
    execFileSync('git', ['commit', '--amend', '-qm', 'init', '--date', String(ts)], {
      cwd: dir,
      env: { ...process.env, GIT_COMMITTER_DATE: `${new Date(ts * 1000).toUTCString()}` },
    });
    const a = stalenessGate(dir, { mode: 'off' });
    expect(a.fatal).toBe(false);
    expect(a.stderrLines).toEqual([]);
    expect(a.staleness.stale).toBe(true); // verdict still measured, just not acted on
  });

  it('fatal mode on a FRESH tree is not fatal (no false alarm)', () => {
    const dir = path.join(tmpPath('gate-fresh'), 'gate-fresh');
    initRepo(dir);
    const a = stalenessGate(dir, { mode: 'fatal' });
    expect(a.fatal).toBe(false);
  });

  /**
   * The other half of the narrowed rule: the HARD signal still refuses. HEAD sits behind a
   * remote-tracking ref that exists locally, so the checkout provably lacks commits upstream
   * already has — that IS evidence the served content is old, unlike commit age.
   */
  it('fatal DOES refuse when HEAD is behind its already-fetched upstream (hard evidence)', () => {
    const dir = path.join(tmpPath('gate-behind'), 'gate-behind');
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'b.md'), '# b\n');
    execFileSync('git', ['add', 'b.md'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'second'], { cwd: dir });
    const second = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
    execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, second], { cwd: dir });
    execFileSync('git', ['update-ref', `refs/heads/${branch}`, 'HEAD~1'], { cwd: dir });
    execFileSync('git', ['config', `branch.${branch}.remote`, 'origin'], { cwd: dir });
    execFileSync('git', ['config', `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd: dir });
    const a = stalenessGate(dir, { mode: 'fatal' });
    expect(a.staleness.behind).toBe(1);
    expect(a.fatal).toBe(true);
  });
});

describe('stalenessJsonField', () => {
  /**
   * CATCHES: the D1 guard changing the FROZEN `search --json` contract on a
   * healthy vault. `tests/context/product-read-context-contract.test.ts`
   * requires the un-armed response to be byte-identical to the shipped one —
   * no new top-level key — so an always-present `vaultStaleness` key is a
   * contract break even when its value is `false`. Mutating this gate to emit
   * the key unconditionally must fail this test.
   */
  it('a healthy (non-stale) verdict adds NO key — the shipped shape is untouched', () => {
    const field = stalenessJsonField({ stale: false, reasons: [], kind: 'plain' });
    expect(Object.keys(field)).toEqual([]);
    expect(field.vaultStaleness).toBeUndefined();
    // Byte-identical to what the shipped handler emitted before this feature.
    expect(JSON.stringify({ hits: [], ...field })).toBe('{"hits":[]}');
    // Arming the guard does not change that: a healthy vault is never stale.
    expect(Object.keys(stalenessJsonField({ stale: false, reasons: [], kind: 'git' }, { mode: 'warn', armed: true }))).toEqual([]);
  });

  it('a stale verdict IS attached once the guard is explicitly armed, so the client sees the stale serve', () => {
    const verdict = { stale: true, reasons: ['HEAD is 3 commit(s) behind'], kind: 'git' as const };
    const field = stalenessJsonField(verdict, { mode: 'warn', armed: true });
    expect(Object.keys(field)).toEqual(['vaultStaleness']);
    expect(field.vaultStaleness).toStrictEqual(verdict);
  });

  /**
   * CATCHES: the contract break the "stale-only" rule could not see. The shipped
   * contract test's fixture is a plain, non-git folder, so it can never reach the stale
   * path; measured on a stale git vault at d0af43f3 the un-armed response was
   * `['hits','vaultStaleness']` and the repository's own assertion failed
   * (`expected [ 'hits', 'vaultStaleness' ] to deeply equal [ 'hits' ]`). An UNSET flag is
   * not an armed guard: the frozen shape must survive a stale vault too.
   */
  it('a stale verdict adds NO key while the flag is UNSET — the un-armed response stays byte-identical', () => {
    const verdict = { stale: true, reasons: ['HEAD commit is 12d old (>3d)'], kind: 'git' as const };
    const saved = process.env.RENOR_VAULT_STALENESS;
    delete process.env.RENOR_VAULT_STALENESS;
    try {
      // No opts: the function reads the environment, exactly as cli.ts calls it.
      const field = stalenessJsonField(verdict);
      expect(Object.keys(field)).toEqual([]);
      expect(JSON.stringify({ hits: [], ...field })).toBe('{"hits":[]}');
      // Mutating the gate back to `stale ? key : {}` must fail here.
      expect(JSON.stringify({ hits: [], ...stalenessJsonField(verdict, { armed: false }) })).toBe('{"hits":[]}');
      // And an explicit `off` mutes the field as it mutes the banner.
      expect(Object.keys(stalenessJsonField(verdict, { mode: 'off', armed: true }))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.RENOR_VAULT_STALENESS;
      else process.env.RENOR_VAULT_STALENESS = saved;
    }
  });
});