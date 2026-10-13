import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeConversation } from '../../src/conversation/writer';
import { SecretRefusedError } from '../../src/extraction/secretGuard';
import { scanSecrets } from '../../src/extraction/secretScanner';
import { formatConversation } from '../../src/conversation/formatter';
import type { ParsedConversation } from '../../src/conversation/types';
import { KEY_SHAPES, Rng } from '../../scripts/eval/secret-guard/plantedSet';

/**
 * RENOR_SECRET_GUARD on the conversation logger (the `log-conversation` Stop hook), the one command that writes a
 * transcript into the vault without going through `remember`. With the guard on, a transcript the scanner flags is not
 * written and the directory is not created; the hook already reports any error and exits cleanly. Planted secrets only.
 */

const SAVED = process.env.RENOR_SECRET_GUARD;
const KEY = KEY_SHAPES.anthropic(new Rng(77));
const fragments = (secret: string) => [secret.slice(-14), secret.slice(0, 10)].filter(f => f.length >= 8);

const conversation = (text: string, title = 'Fix auth bug'): ParsedConversation => ({
  sessionId: 'abc-123', title, timeStart: '2026-04-03T10:30:00.000Z', project: '/Users/test/project',
  turns: [{ role: 'user', text, toolCalls: [] }],
});

let vault: string;
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-guard-'));
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.RENOR_SECRET_GUARD;
  else process.env.RENOR_SECRET_GUARD = SAVED;
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('writeConversation with the secret guard on', () => {
  it('refuses a transcript with a credential in it, writes nothing and creates no directory, and does not repeat the secret', async () => {
    process.env.RENOR_SECRET_GUARD = '1';
    const err = await writeConversation(vault, 'Claude Code/Conversations', conversation(`please use this key: ${KEY}`)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SecretRefusedError);
    expect(err).toMatchObject({ field: 'conversation', reason: 'credential', action: 'save' });
    const message = (err as SecretRefusedError).message;
    expect(message).toMatch(/^Nothing was saved: the conversation appears to contain a credential/);
    for (const f of fragments(KEY)) expect(message).not.toContain(f);
    expect(fs.readdirSync(vault)).toEqual([]);
  });

  it('screens the file name as it will be stored: forbidden characters in a title become dashes, which can join the pieces of a token', async () => {
    process.env.RENOR_SECRET_GUARD = '1';
    const token = KEY_SHAPES.github(new Rng(5));
    const conv = conversation('Please fix the login redirect, it loops.', `${token.slice(0, 16)}:${token.slice(16)}`);
    // the premise: as the transcript reads it, the title is two short pieces, not a token
    expect(scanSecrets(formatConversation(conv))).toBeNull();
    const err = await writeConversation(vault, 'Claude Code/Conversations', conv).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SecretRefusedError);
    expect(err).toMatchObject({ field: 'conversation file name', reason: 'credential' });
    for (const f of fragments(token)) expect((err as SecretRefusedError).message).not.toContain(f);
    expect(fs.readdirSync(vault)).toEqual([]);
  });

  it('writes an ordinary transcript exactly as it does without the guard', async () => {
    process.env.RENOR_SECRET_GUARD = '1';
    const guarded = await writeConversation(vault, 'Claude Code/Conversations', conversation('Please fix the login redirect, it loops.'));
    const bytes = fs.readFileSync(guarded, 'utf8');
    delete process.env.RENOR_SECRET_GUARD;
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-guard-open-'));
    try {
      const open = await writeConversation(other, 'Claude Code/Conversations', conversation('Please fix the login redirect, it loops.'));
      expect(path.relative(vault, guarded)).toBe(path.relative(other, open));
      expect(fs.readFileSync(open, 'utf8')).toBe(bytes);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('writes the same flagged transcript with the guard off, which is what the guard was stopping', async () => {
    delete process.env.RENOR_SECRET_GUARD;
    const file = await writeConversation(vault, 'Claude Code/Conversations', conversation(`please use this key: ${KEY}`));
    expect(fs.readFileSync(file, 'utf8')).toContain(KEY);
  });
});
