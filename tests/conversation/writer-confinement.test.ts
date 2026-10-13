// Adversary run renor-adv-vaultfs-1012, F1: the conversation log (`renor log-conversation`) is written into the vault with the
// same unchecked mkdir + writeFile as the daily log was. A link or a hard link planted in the vault must not send it elsewhere.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeConversation } from '../../src/conversation/writer';
import type { ParsedConversation } from '../../src/conversation/types';

let root: string;
let vault: string;
let outside: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'confined-conv-')));
  vault = path.join(root, 'vault');
  outside = path.join(root, 'outside');
  fs.mkdirSync(vault);
  fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const CANARY = 'OUTSIDE-FILE-CANARY\n';
const REFUSED = /refusing to write/;

describe('a conversation log', () => {
  const conv: ParsedConversation = {
    sessionId: 'abc-123', title: 'Fix auth bug', timeStart: '2026-04-03T10:30:00.000Z',
    project: '/Users/test/project', turns: [{ role: 'user', text: 'Please fix it', toolCalls: [] }],
  };
  const name = '2026-04-03 10-30 - Fix auth bug.md';

  it('is not written through a symlink at its file name', async () => {
    fs.writeFileSync(path.join(outside, 'c.md'), CANARY);
    fs.mkdirSync(path.join(vault, 'Claude Code/Conversations'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'c.md'), path.join(vault, 'Claude Code/Conversations', name));
    await expect(writeConversation(vault, 'Claude Code/Conversations', conv)).rejects.toThrow(REFUSED);
    expect(fs.readFileSync(path.join(outside, 'c.md'), 'utf8')).toBe(CANARY);
  });

  it('is not written below a symlinked conversations directory', async () => {
    fs.mkdirSync(path.join(vault, 'Claude Code'));
    fs.mkdirSync(path.join(outside, 'convs'));
    fs.symlinkSync(path.join(outside, 'convs'), path.join(vault, 'Claude Code/Conversations'));
    await expect(writeConversation(vault, 'Claude Code/Conversations', conv)).rejects.toThrow(REFUSED);
    expect(fs.readdirSync(path.join(outside, 'convs'))).toEqual([]);
  });

  it('is not written through a hard link', async () => {
    fs.writeFileSync(path.join(outside, 'h.md'), CANARY);
    fs.mkdirSync(path.join(vault, 'Claude Code/Conversations'), { recursive: true });
    fs.linkSync(path.join(outside, 'h.md'), path.join(vault, 'Claude Code/Conversations', name));
    await expect(writeConversation(vault, 'Claude Code/Conversations', conv)).rejects.toThrow(REFUSED);
    expect(fs.readFileSync(path.join(outside, 'h.md'), 'utf8')).toBe(CANARY);
  });

  it('replaces an earlier copy of the same conversation, as before', async () => {
    const file = await writeConversation(vault, 'Claude Code/Conversations', conv);
    fs.writeFileSync(file, 'x'.repeat(10000));
    await writeConversation(vault, 'Claude Code/Conversations', conv);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('Fix auth bug');
    expect(text).not.toContain('xxxx');
  });
});
