// The owner's approvals of standing rules: the only thing that makes a saved rule an instruction.
//
// Anyone who may save a fact (any agent with a key, a shared-workspace member) can save one under the subject
// "standing rule". So the hook never treats that text as the user's word by itself: a rule is shown as an instruction
// only when its exact saved event (event id, scope, topic, text and author) is in this file, which the owner fills
// from a terminal with approve.mjs. A changed or superseded rule is a new event, so it needs approving again.
//
// The file lives on the owner's machine (RENOR_STANDING_RULES_APPROVALS, else ~/.renor/standing-rules-approved.json,
// mode 0600) and is never sent anywhere. Nothing on the Renor side can write it. Anything that can write the owner's
// files can also write this one, as it can write CLAUDE.md: that is outside what this guards against.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function approvalsPath(env = process.env) {
  return String(env.RENOR_STANDING_RULES_APPROVALS ?? '').trim() || path.join(os.homedir(), '.renor', 'standing-rules-approved.json');
}

/** The key of one saved rule: a digest of the event it came from and everything shown of it. */
export function ruleKey(rule) {
  const parts = [rule.eventId ?? '', rule.scope ?? 'global', rule.predicate ?? '', rule.object ?? '', rule.source ?? ''];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** The approved keys, or an empty set when the file is missing or unreadable (nothing is approved then). */
export function readApprovals(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(Array.isArray(parsed?.approved) ? parsed.approved.filter(k => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)) : []);
  } catch {
    return new Set();
  }
}

/** Writes `keys` owner-only, through a temporary file, so a half-written file is never read. */
export function writeApprovals(file, keys) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ approved: [...keys].sort() }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
