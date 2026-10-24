#!/usr/bin/env node
// Claude Code SessionStart hook (matchers startup, clear, compact): puts the standing rules the owner approved in front
// of the agent with no search query, and again after /clear and after compaction, which drop them from the context.
//
// Default OFF. It reads nothing and sends nothing unless RENOR_STANDING_RULES_HOOK=1 and a Renor connect token is set
// (RENOR_CONNECT_TOKEN, else RENOR_AUTO_RECALL_TOKEN, the key the recall hooks use). Claude Code passes both to hooks from
// the `env` block of ~/.claude/settings.json. Every failure is silent: no output, exit 0, so it never blocks a session
// start beyond its deadline. RENOR_HOOK_DEBUG=1 names the kind of failure on stderr, never remote text or the token.

import { pathToFileURL } from 'node:url';
import { standingRulesBlock, DEFAULT_MAX_TOKENS } from './standing-rules.mjs';
import { createHttpClient, HookError } from './mcp-http.mjs';
import { approvalsPath, readApprovals } from './approvals.mjs';

export const DEFAULT_URL = 'https://mcp.renor.cloud/mcp';
export const DEFAULT_TIMEOUT_MS = 4000;
/** The session starts that lose what was in context. A resume or fork keeps the transcript, so the block is still there. */
export const SOURCES = new Set(['startup', 'clear', 'compact']);

const on = value => ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());

/** The token the hooks use, from the environment ('' when none). */
export const tokenOf = env => String(env.RENOR_CONNECT_TOKEN ?? env.RENOR_AUTO_RECALL_TOKEN ?? '').trim();

/** What the hook would do with this environment: null when it is off or has no token. Nothing else is read when off. */
export function hookSettings(env = process.env) {
  if (!on(env.RENOR_STANDING_RULES_HOOK)) return null;
  const token = tokenOf(env);
  if (!token) return null;
  const cap = Number(env.RENOR_STANDING_RULES_MAX_TOKENS);
  return {
    token,
    url: String(env.RENOR_MCP_URL ?? '').trim() || DEFAULT_URL,
    maxTokens: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    approvals: approvalsPath(env),
  };
}

/** The one line debug mode writes: the failure's category, never its message unless it is a HookError's own. */
function debugLine(err, env) {
  const category = err instanceof HookError ? err.category : err?.message === 'timeout' ? 'timeout' : 'internal-error';
  const token = tokenOf(env);
  // A category holds no remote text; the token is cut out anyway, should one ever carry it.
  return `renor standing rules: ${token ? category.split(token).join('[token]') : category}\n`;
}

/**
 * The hook's stdout for one SessionStart input, or '' for none. `deps.client` replaces the HTTP client and
 * `deps.approvals` the owner's approval set (tests, or a sibling hook that composes this block into its own
 * SessionStart output). Never throws.
 */
export async function sessionStartOutput(input, env = process.env, deps = {}) {
  try {
    if (!SOURCES.has(input?.source)) return '';
    const settings = hookSettings(env);
    if (!settings && !deps.client) return '';
    const signal = AbortSignal.timeout(settings?.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const client = deps.client ?? createHttpClient({ url: settings.url, token: settings.token, signal, fetchImpl: deps.fetch });
    const approvals = deps.approvals ?? readApprovals(settings?.approvals ?? approvalsPath(env));
    const deadline = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new HookError('timeout')), { once: true }));
    const { block } = await Promise.race([
      standingRulesBlock(client, { maxTokens: settings?.maxTokens ?? deps.maxTokens ?? DEFAULT_MAX_TOKENS, approvals }),
      deadline,
    ]);
    if (!block) return '';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: block } });
  } catch (err) {
    if (on(env.RENOR_HOOK_DEBUG)) process.stderr.write(debugLine(err, env));
    return '';
  }
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = {};
  try { input = JSON.parse(await readStdin()); } catch { /* no input: nothing to do */ }
  const out = await sessionStartOutput(input);
  if (out) process.stdout.write(out);
  process.exit(0);
}
