// Vault-staleness guard (D1). The production indexer once served a vault
// checkout that was 330 commits / 12 days stale and nothing alarmed — the fix
// is to make staleness a loud, machine-readable signal at startup instead of a
// silent property of a mis-configured VAULT_PATH.
//
// LOCAL-ONLY by design: this module never runs `git fetch` or any network call.
// It compares HEAD against the ALREADY-FETCHED upstream ref (refs/remotes/*)
// and HEAD's own commit age. A stale *fetch* is a deployment concern (a cron
// `git fetch` upstream); a stale *index* at read time is the failure D1
// shipped, and both signals catch that class.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type StalenessMode = 'off' | 'warn' | 'fatal';

export interface VaultStaleness {
  /** true when any configured signal fired. */
  stale: boolean;
  /**
   * Human-readable reasons, one per fired signal.
   *
   * `behind` is HARD evidence (the checkout provably lacks commits upstream has) and is the
   * only signal `stalenessGate` makes fatal; every age reason is ADVISORY (activity heuristic)
   * and never refuses to serve. See `stalenessGate`.
   */
  reasons: string[];
  /** Machine-readable detail (indexHEAD, upstream, ages). */
  head?: string;
  upstream?: string | null;
  behind?: number;
  headAgeDays?: number;
  /**
   * The work-tree root this verdict was made against.
   *
   * Equals `vaultPath` when that path is itself a checkout root, and the ENCLOSING work tree
   * when the vault is a subdirectory of one. For a vault anywhere under this repository that
   * enclosing root is the PLATFORM repository, because `engine/` is a subtree of it — see
   * `checkVaultStaleness`. Recorded so a nested vault's alarm is attributable to the checkout
   * that was actually judged instead of reading as the vault's own repository.
   */
  repoRoot?: string;
  /** 'git' = inside a work tree (judged); 'plain' = in no work tree at all (nothing to judge). */
  kind: 'git' | 'plain';
}

const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the upstream ref of the current branch WITHOUT any network I/O:
 * branch.<name>.remote + branch.<name>.merge → refs/remotes/<remote>/<branch>.
 * Detached HEAD or no upstream → null (age signal still applies).
 */
function upstreamRef(cwd: string): string | null {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return null;
  const remote = git(cwd, ['config', '--get', `branch.${branch}.remote`]);
  const merge = git(cwd, ['config', '--get', `branch.${branch}.merge`]);
  if (!remote || !merge) return null;
  const ref = merge.replace('refs/heads/', `refs/remotes/${remote}/`);
  // The ref must EXIST locally (fetched at some point). A ref that only
  // exists on the remote is invisible here — that is by design.
  if (!git(cwd, ['rev-parse', '--verify', '--quiet', ref])) return null;
  return ref;
}

/**
 * Evaluate vault staleness for the directory the indexer is about to serve.
 * Zero model calls, zero network. Pure filesystem + local git metadata.
 */
export function checkVaultStaleness(vaultPath: string, opts: { maxHeadAgeDays?: number } = {}): VaultStaleness {
  const maxHeadAgeDays = opts.maxHeadAgeDays ?? 3;
  // WHICH checkout is this verdict about? The vault path itself when it is a work-tree root
  // (`vaultPath/.git` exists — a directory, or a file for a linked worktree or submodule),
  // otherwise the ENCLOSING work tree that contains it. A vault that is a subdirectory of a
  // project repo is an ordinary layout, and answering "plain, never alarm" for it would
  // silently serve exactly the stale checkout this guard exists to catch: measured on a
  // 28-day-old repository, its root reported stale while `<root>/notes` reported
  // `{stale:false, kind:'plain'}`.
  //
  // A nested vault is judged by the SAME checkout-level signals as a root one — behind the
  // already-fetched upstream ref, and HEAD commit age — so two vaults inside one repository
  // cannot mean two different things.
  //
  // The enclosing root is often the PLATFORM repository, and that is stated here rather than
  // rediscovered: `engine/` is a subtree of the platform repo, so `git rev-parse
  // --show-toplevel` run from inside `engine/` returns the platform root — which is exactly why
  // `engine/scripts/ci/local.sh` (lines 25-28) and `engine/scripts/eval/run-cycle.sh`
  // (lines 3-6) resolve their own root from `$0` instead of asking git. So a vault under this
  // checkout is judged against the platform checkout, and `repoRoot` records that.
  const isWorkTreeRoot = fs.existsSync(path.join(vaultPath, '.git'));
  const repoRoot = isWorkTreeRoot ? vaultPath : git(vaultPath, ['rev-parse', '--show-toplevel']);
  if (!repoRoot) {
    // In no work tree at all: nothing to judge, never alarm on a plain folder.
    return { stale: false, reasons: [], kind: 'plain' };
  }
  const reasons: string[] = [];
  const out: VaultStaleness = { stale: false, reasons: [], kind: 'git', repoRoot };
  // A nested vault is judged against the ENCLOSING checkout, so every reason it produces names
  // that root: a refusal whose banner read only "HEAD is 3 commit(s) behind" would not tell the
  // operator WHICH repository is behind, and `fatal` exits before anything else is printed.
  const scope = repoRoot === vaultPath ? '' : ` (enclosing checkout ${repoRoot})`;

  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  out.head = head ?? undefined;
  if (!head) return out; // unreadable repo — do not guess, do not alarm

  const upstream = upstreamRef(repoRoot);
  out.upstream = upstream;
  if (upstream) {
    const aheadBehind = git(repoRoot, ['rev-list', '--left-right', '--count', `${upstream}...${head}`]);
    if (aheadBehind) {
      const [behindStr] = aheadBehind.split(/\s+/);
      const behind = parseInt(behindStr, 10);
      out.behind = behind;
      if (behind > 0) {
        reasons.push(`HEAD is ${behind} commit(s) behind local upstream ref ${upstream}${scope}`);
      }
    }
  }

  const ts = git(repoRoot, ['log', '-1', '--format=%ct', 'HEAD']);
  if (ts) {
    const ageDays = Math.max(0, (Date.now() - parseInt(ts, 10) * 1000) / DAY_MS);
    out.headAgeDays = Math.round(ageDays * 10) / 10;
    if (ageDays > maxHeadAgeDays) {
      reasons.push(`HEAD commit is ${out.headAgeDays}d old (>${maxHeadAgeDays}d) — the checkout may not be receiving updates${scope}`);
    }
  }

  out.stale = reasons.length > 0;
  out.reasons = reasons;
  return out;
}

/** RENOR_VAULT_STALENESS=off|warn|fatal (default warn; empty/unset = warn). */
export function stalenessMode(): StalenessMode {
  const raw = (process.env.RENOR_VAULT_STALENESS ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'warn' || raw === 'fatal') return raw;
  return 'warn';
}

export interface StalenessAction {
  /** stderr lines to print before any indexing/serving starts. */
  stderrLines: string[];
  /** exit-code signal for fatal mode (caller decides; never exits internally). */
  fatal: boolean;
  /** The raw evaluation. */
  staleness: VaultStaleness;
}

/**
 * Is the guard EXPLICITLY armed?
 *
 * `RENOR_VAULT_STALENESS` unset means "the operator asked for nothing", which is not the
 * same as asking for `warn`: `stalenessMode()` defaults to `warn` so the startup banner is
 * loud by default, but a default the operator never typed must never change a response
 * shape. Only the two modes that name a behaviour explicitly count as armed.
 */
export function stalenessArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_VAULT_STALENESS ?? '').trim().toLowerCase();
  return raw === 'warn' || raw === 'fatal';
}

/**
 * The `search --json` field for a staleness verdict, or nothing.
 *
 * The machine-readable transport is a FROZEN public contract: its own test
 * (`tests/context/product-read-context-contract.test.ts`, "adds nothing to the
 * response when the flag is unset") requires the un-armed response to be
 * byte-identical to the shipped one — no new top-level key.
 *
 * That is why the verdict is OPT-IN, and why the earlier "stale-only" rule was not enough.
 * Stale-only kept the key off a healthy vault, but the shipped contract test's fixture is a
 * plain, non-git folder (`kind: 'plain'`, never stale), so it could not see the stale path:
 * a stale vault with `RENOR_VAULT_STALENESS` UNSET still returned `['hits','vaultStaleness']`
 * and the repo's own assertion failed on exactly that vault
 * (`expected [ 'hits', 'vaultStaleness' ] to deeply equal [ 'hits' ]`). Measured, not reasoned.
 *
 * So the field is attached only when the guard is EXPLICITLY armed (see `stalenessArmed`) AND
 * the vault is stale. An operator who types `RENOR_VAULT_STALENESS=warn` gets the signal on
 * the client surface as well as on stderr; an operator who types nothing gets a response
 * byte-identical to the shipped one, stale or not. `off` mutes the field as it mutes the banner.
 */
export function stalenessJsonField(
  staleness: VaultStaleness,
  opts: { mode?: StalenessMode; armed?: boolean } = {},
): { vaultStaleness?: VaultStaleness } {
  const mode = opts.mode ?? stalenessMode();
  const armed = opts.armed ?? stalenessArmed();
  if (!armed || mode === 'off' || !staleness.stale) return {};
  return { vaultStaleness: staleness };
}

/**
 * Gate helper for cli.ts setup(): evaluate + render. Pure — no process.exit,
 * no console. The caller prints stderrLines and may refuse to continue.
 *
 * WHICH SIGNAL IS FATAL, stated because the two are different kinds of evidence:
 *
 *   - HARD, fatal-capable: `behind > 0` — HEAD is behind the ALREADY-FETCHED upstream ref.
 *     The local checkout provably does not have commits upstream already has, so refusing to
 *     serve is refusing to serve content that is known to be old.
 *   - ADVISORY, never fatal: `headAgeDays > maxHeadAgeDays` — the checkout has received no
 *     commits for N days. It exists because `behind` cannot see a stale FETCH (nothing fetched
 *     means nothing to be behind of), but age alone is a heuristic about activity, not proof
 *     that the content is outdated: a quiet vault whose HEAD still matches its upstream would
 *     otherwise be taken offline by `fatal` with no knob to tune the threshold.
 *
 * So `fatal` fires only on the hard signal. An age-only verdict still renders its banner and
 * still reaches the JSON field when the guard is armed; it just does not stop serving.
 */
export function stalenessGate(vaultPath: string, opts: { mode?: StalenessMode; maxHeadAgeDays?: number } = {}): StalenessAction {
  const mode = opts.mode ?? stalenessMode();
  const staleness = checkVaultStaleness(vaultPath, opts);
  const hardEvidence = (staleness.behind ?? 0) > 0;
  const stderrLines: string[] = [];
  if (staleness.stale && mode !== 'off') {
    for (const r of staleness.reasons) {
      stderrLines.push(`[staleness] VAULT STALE: ${r}`);
    }
    // The hint must not contradict the narrowed rule: telling an operator who is ALREADY in
    // `fatal` mode to "set =fatal to fail startup" is noise, and calling an age-only verdict
    // "out-of-date" asserts more than age establishes.
    stderrLines.push(
      hardEvidence
        ? '[staleness] serving an out-of-date vault silently caused defect D1; set RENOR_VAULT_STALENESS=fatal to fail startup, or off to mute'
        : '[staleness] the age signal is ADVISORY and never refuses service; only HEAD behind its already-fetched upstream is fatal. Set RENOR_VAULT_STALENESS=off to mute',
    );
  }
  return { stderrLines, fatal: mode === 'fatal' && hardEvidence, staleness };
}