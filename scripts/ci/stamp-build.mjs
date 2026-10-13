#!/usr/bin/env node
/**
 * Writes dist/BUILD.json at build time so the running service can self-report
 * exactly which source commit it was built from (deploy-drift observability).
 * Read at runtime by GET /version (src/mvp/server.ts) and GET /api/health
 * (src/api/server.ts), both through src/buildIdentity.ts.
 *
 * WHERE THE IDENTITY COMES FROM, in this order:
 *   1. RENOR_BUILD_COMMIT / _BRANCH / _DIRTY — what the deploy supplies.
 *      An uploaded release tarball has no .git, so `git` can only answer "unknown"
 *      there, and until this read the env it did: every release built by
 *      deploy-remote.sh stamped commit=unknown while the deploy script printed the
 *      real sha (reported 2026-10-02 on a publish of 9048cc37). The supplied value
 *      wins because it is the identity resolved for the exact tree that ships, and
 *      because the tarball is a copy of the WORKING TREE rather than of HEAD.
 *   2. git in this checkout — a local or CI build, where there is no deploy to ask.
 *
 * FAILS THE BUILD when neither can name the commit. A stamp reading `unknown` is
 * worse than no stamp: /version would report a build identity that does not exist,
 * and the release would still be published and served. So this writes nothing and
 * exits non-zero, which stops `npm run build` and therefore stops the deploy before
 * the pointer moves. A build that cannot say which commit it is from must not
 * produce a runnable artifact.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distDir = join(root, "dist");

// The shape src/buildIdentity.ts accepts (COMMIT_PATTERN): a hex revision id, 7-40
// chars. Checked here so the build refuses an identity the /version surface would
// silently downgrade to "unknown" anyway — a rejected value must never become a stamp.
const COMMIT_PATTERN = /^[0-9a-fA-F]{7,40}$/;
/** What deploy-remote.sh substitutes when its caller supplied no commit. Not an identity. */
const NOT_SUPPLIED = new Set(["", "unknown"]);

// git's own stderr is dropped: "fatal: not a git repository" is an expected answer on
// the VM, not a failure, and printing it next to a successful stamp reads like the
// stamp failed. A genuine failure is reported by this script, below, with the remedy.
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function gitDirty() {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().length > 0;
}

/** The deploy's dirty flag, or null when it supplied nothing this script can read. */
function suppliedDirty() {
  const value = (process.env.RENOR_BUILD_DIRTY ?? "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

const suppliedCommit = (process.env.RENOR_BUILD_COMMIT ?? "").trim();
if (!NOT_SUPPLIED.has(suppliedCommit) && !COMMIT_PATTERN.test(suppliedCommit)) {
  // Falling back to git here would stamp a DIFFERENT identity from the one the deploy
  // reported, which is exactly the drift this script exists to remove. A malformed
  // value is a bug in the caller, and the build stops on it.
  console.error(
    `[stamp-build] RENOR_BUILD_COMMIT='${suppliedCommit}' is not a commit ` +
      `(expected a hex revision id of 7-40 characters, as 'git rev-parse HEAD' prints). ` +
      `Refusing to stamp a build identity the /version surface would reject.`,
  );
  process.exit(1);
}

let commit = "";
let branch = "";
let dirty = null;

if (!NOT_SUPPLIED.has(suppliedCommit)) {
  commit = suppliedCommit;
  branch = (process.env.RENOR_BUILD_BRANCH ?? "").trim();
  dirty = suppliedDirty();
}

if (!commit) {
  commit = git(["rev-parse", "HEAD"]);
  if (commit) {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "detached";
    if (branch === "HEAD") branch = "detached";
    try {
      dirty = gitDirty();
    } catch {
      /* the tree is a checkout but its status is unreadable: report no dirty claim */
    }
  }
}

if (!commit) {
  console.error(
    `[stamp-build] cannot name the commit this build is from, so it is writing no manifest.\n` +
      `  This tree is not a git checkout (an uploaded release tarball has no .git) and\n` +
      `  RENOR_BUILD_COMMIT was not supplied.\n` +
      `  Why it matters: /version and /api/health would report commit "unknown" for a build that\n` +
      `  nobody can identify, and the release would still be published.\n` +
      `  How to fix it: a deploy must pass the commit it packed — RENOR_BUILD_COMMIT=<full sha>\n` +
      `  (engine/scripts/alpha/deploy-remote.sh does this; a local or CI build runs inside a\n` +
      `  checkout and needs no variable).`,
  );
  process.exit(1);
}

const info = { commit, branch: branch || "unknown", dirty, builtAt: new Date().toISOString() };
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "BUILD.json"), JSON.stringify(info, null, 2) + "\n");
console.log(`[stamp-build] ${info.commit.slice(0, 12)} (${info.branch}, dirty=${info.dirty}) at ${info.builtAt}`);
