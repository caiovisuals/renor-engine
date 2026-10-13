import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Build identity of the running process: which source commit is this instance
 * actually running?
 *
 * Written at build time by scripts/ci/stamp-build.mjs to <engine>/dist/BUILD.json.
 * Deploy drift (a tenant serving an older commit than the owner's instance) has
 * to be observable from the running service itself, so both HTTP surfaces —
 * the librarian's GET /api/health and the MVP's GET /version the alpha tenants
 * run — read the manifest through THIS single code path.
 *
 * Reading is fail-soft by contract and dependency-free: a missing, unreadable,
 * oversized or malformed manifest reports "unknown" fields and never throws. A
 * malformed manifest reports unknown rather than falling back to a guessed
 * value — a wrong version claim is worse than an honest "unknown".
 *
 * VALIDATION CONTRACT (why every field is shape-checked before it is emitted):
 * the manifest is not only written by a trusted local git call — the deploy
 * pipeline stamps it too (environment variables plus a revision file). Whatever
 * lands in it is therefore untrusted input, and both consumers return it over
 * HTTP. Every field is validated against the shape of the thing it claims to
 * be and length-capped before it leaves this module; a value that fails is
 * replaced by the "unknown" placeholder — never echoed, never truncated, never
 * coerced. "unknown" is deliberately the SAME marker an absent manifest
 * produces: both mean "this instance has no trustworthy build identity", and a
 * caller that needs to distinguish "unstamped" from "stamped with a value we
 * reject" is out of scope for a deploy-parity probe.
 */
export interface BuildIdentity {
  commit: string;
  branch: string;
  /** Whether the build tree had uncommitted changes; null when unstamped. */
  dirty: boolean | null;
  /** ISO instant of the build; null when unstamped. */
  builtAt: string | null;
}

const UNKNOWN_BUILD_IDENTITY: BuildIdentity = Object.freeze({
  commit: 'unknown',
  branch: 'unknown',
  dirty: null,
  builtAt: null,
});

/**
 * Manifest size gate. A stamp written by scripts/ci/stamp-build.mjs is ~200
 * bytes, so anything in the KiB range is not a build stamp this project wrote.
 * Refusing it by size (before the contents are even parsed) bounds the work and
 * the memory the reader can be forced into, and keeps a giant file from ever
 * becoming the input to a response.
 */
export const MAX_BUILD_MANIFEST_BYTES = 4096;

/** A git revision id as printed by `git rev-parse HEAD`, shortened or full. */
const COMMIT_PATTERN = /^[0-9a-fA-F]{7,40}$/;

/**
 * ISO-8601 instant: calendar date, time to the second, optional fractional
 * seconds, and either `Z` or a numeric offset — the shapes `Date#toISOString`
 * and ordinary ISO producers emit. Anything else (partial dates, prose,
 * dates with embedded whitespace) is not a build timestamp.
 */
const BUILT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Longest ISO instant worth accepting (offset + 6 fractional digits). */
const MAX_BUILT_AT_LENGTH = 35;

/** Git ref names are ASCII: letters, digits, `.`, `_`, `-` and `/` separators. */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
/** git's own per-ref-component cap is 255 bytes; nothing legitimate is longer. */
const MAX_BRANCH_LENGTH = 255;

/** The engine package root: nearest ancestor of this module holding package.json. */
function resolveEngineRoot(): string | null {
  let dir = __dirname;
  for (let up = 0; up < 3; up += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Absolute path of the stamped manifest, or null when the package root cannot
 * be located (then identity is simply unknown — never a guess).
 *
 * Resolved from the package root rather than a fixed relative hop because the
 * two layouts differ: a compiled deployment loads this module from dist/ while
 * a source run (tsx: `npm run mvp`, `renor serve`) loads it from src/, and both
 * must find <engine>/dist/BUILD.json.
 */
export const BUILD_MANIFEST_PATH: string | null = (() => {
  const root = resolveEngineRoot();
  return root === null ? null : join(root, 'dist', 'BUILD.json');
})();

/** Hex revision id, or the unknown placeholder. */
function validatedCommit(value: unknown): string {
  return typeof value === 'string' && COMMIT_PATTERN.test(value)
    ? value
    : UNKNOWN_BUILD_IDENTITY.commit;
}

/**
 * Plausible git ref name, or the unknown placeholder. Enforces the
 * `git check-ref-format` rules a charset check alone would miss (`..`, `@{`,
 * leading dot, `.lock` suffix, empty component), so a filesystem path, a tenant
 * slug, a URL or a ref-shaped injection cannot pass as a branch.
 */
function validatedBranch(value: unknown): string {
  const unknown = UNKNOWN_BUILD_IDENTITY.branch;
  if (typeof value !== 'string' || value.length > MAX_BRANCH_LENGTH) return unknown;
  if (!BRANCH_PATTERN.test(value)) return unknown;
  if (value.includes('..') || value.includes('@{')) return unknown;
  for (const component of value.split('/')) {
    if (component === '' || component.startsWith('.')) return unknown;
    if (component.endsWith('.lock')) return unknown;
  }
  return value;
}

/** Parsable ISO-8601 instant, or null. */
function validatedBuiltAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_BUILT_AT_LENGTH) return null;
  if (!BUILT_AT_PATTERN.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Reads the build manifest. Returns the unknown identity — never throws — when
 * the manifest is absent, unreadable, oversized, not JSON, not an object, or
 * carries a value that fails its field's shape check.
 */
export function readBuildIdentity(manifestPath: string | null = BUILD_MANIFEST_PATH): BuildIdentity {
  if (manifestPath === null) return { ...UNKNOWN_BUILD_IDENTITY };
  let raw: string;
  try {
    if (statSync(manifestPath).size > MAX_BUILD_MANIFEST_BYTES) {
      return { ...UNKNOWN_BUILD_IDENTITY }; // not a stamp we wrote
    }
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return { ...UNKNOWN_BUILD_IDENTITY }; // pre-stamp / snapshot deployment
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...UNKNOWN_BUILD_IDENTITY };
    }
    const manifest = parsed as Record<string, unknown>;
    return {
      commit: validatedCommit(manifest.commit),
      branch: validatedBranch(manifest.branch),
      dirty: typeof manifest.dirty === 'boolean' ? manifest.dirty : null,
      builtAt: validatedBuiltAt(manifest.builtAt),
    };
  } catch {
    return { ...UNKNOWN_BUILD_IDENTITY };
  }
}
