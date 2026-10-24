#!/usr/bin/env node
// The owner approves standing rules, one by one, from a terminal:
//
//   RENOR_CONNECT_TOKEN=<connect token> node <plugin>/hooks/standing-rules/approve.mjs          approve new rules
//   RENOR_CONNECT_TOKEN=<connect token> node <plugin>/hooks/standing-rules/approve.mjs --list   show each rule's state
//
// It reads the rules saved under "standing rule" (retrieve_memory), shows each one not yet approved with the agent
// that saved it, its date, its scope and its text (privacy markers applied), and asks. Only a "y" adds it to the
// approvals file (approvals.mjs). Approvals of rules that are no longer current are dropped. It needs an interactive
// terminal: an agent's shell tool has none, so an agent cannot answer for the owner by running it.

import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { STANDING_RULE_SUBJECT, screenPrivacy, ruleLine } from './standing-rules.mjs';
import { approvalsPath, readApprovals, ruleKey, writeApprovals } from './approvals.mjs';
import { createHttpClient, HookError } from './mcp-http.mjs';
import { DEFAULT_URL, tokenOf } from './session-start.mjs';

/** Each current saved rule with its key and state. Exported for tests. */
export async function savedRules(client, approved) {
  const reply = await client.callTool('retrieve_memory', { subject: STANDING_RULE_SUBJECT });
  return (Array.isArray(reply?.facts) ? reply.facts : [])
    .filter(fact => fact && fact.current !== false)
    .map(fact => ({ ...fact, subject: STANDING_RULE_SUBJECT }))
    .map(fact => ({ fact, key: ruleKey(fact), shown: screenPrivacy(fact), approved: approved.has(ruleKey(fact)) }));
}

/**
 * Asks about every rule not yet approved and returns the new approval set: the approvals still current, plus each
 * rule answered "y". `ask(question) -> Promise<string>`. A rule the privacy rule hides (#norecall) is never offered.
 */
export async function approveInteractively(rows, approved, ask) {
  const current = new Set(rows.map(row => row.key));
  const next = new Set([...approved].filter(key => current.has(key)));
  for (const row of rows) {
    if (row.approved || !row.shown) continue;
    const date = String(row.fact.validFrom ?? '').slice(0, 10) || 'undated';
    const answer = await ask(`${date} ${ruleLine(row.shown)}\nShow this to your agents as your rule? [y/N] `);
    if (/^\s*y(es)?\s*$/i.test(answer)) next.add(row.key);
  }
  return next;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const token = tokenOf(process.env);
  const list = process.argv.includes('--list');
  if (!token) {
    process.stderr.write('Set RENOR_CONNECT_TOKEN to a Renor connect token first.\n');
    process.exit(2);
  }
  if (!list && !(process.stdin.isTTY && process.stdout.isTTY)) {
    process.stderr.write('approve.mjs asks you about each rule, so it needs an interactive terminal. Run it yourself, not through an agent.\n');
    process.exit(2);
  }
  const file = approvalsPath(process.env);
  const client = createHttpClient({ url: String(process.env.RENOR_MCP_URL ?? '').trim() || DEFAULT_URL, token, signal: AbortSignal.timeout(30_000) });
  try {
    const approved = readApprovals(file);
    const rows = await savedRules(client, approved);
    if (list) {
      for (const row of rows) process.stdout.write(`${row.approved ? 'approved' : row.shown ? 'pending ' : 'hidden  '} ${String(row.fact.validFrom ?? '').slice(0, 10)} ${row.shown ? ruleLine(row.shown) : '(#norecall)'}\n`);
      process.exit(0);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const next = await approveInteractively(rows, approved, question => rl.question(question));
    rl.close();
    writeApprovals(file, next);
    process.stdout.write(`${next.size} approved rule${next.size === 1 ? '' : 's'} in ${file}\n`);
  } catch (err) {
    process.stderr.write(`Could not read the rules: ${err instanceof HookError ? err.category : 'internal-error'}\n`);
    process.exit(1);
  }
}
