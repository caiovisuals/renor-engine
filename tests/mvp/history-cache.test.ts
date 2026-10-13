import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { searchHistory, historyCacheChars, HISTORY_CACHE_CHARS } from '../../src/mvp/history';

// search_history used to read, hash and re-tokenize every promoted note on every query (about 0.6 s of CPU per call on
// 20 MB of history). The tokens of a note are now kept for as long as its file and its manifest entry are unchanged, so a
// repeated query reads no note. Synthetic promoted history only, shaped like the promotion command's output.

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function noteText(i: number, body: string): string {
  return `---\nmemory_layer: history\nconversation_id: conv-${i}\ntitle: Conversation ${i}\ncreated: 2026-10-01\nupdated: 2026-10-02\n---\n`
    + `## Visible active branch\n\n${body}\n`;
}

/** A history directory of `count` promoted notes, each holding the words of `bodies[i]`. */
function historyOf(bodies: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-cache-'));
  dirs.push(dir);
  const notes: Record<string, unknown> = {};
  bodies.forEach((body, i) => {
    const name = `chatgpt-${i}.md`;
    const data = Buffer.from(noteText(i, body));
    fs.writeFileSync(path.join(dir, name), data);
    notes[name] = { rel: `notes/${name}`, note_sha256: crypto.createHash('sha256').update(data).digest('hex'), conversation_id: `conv-${i}` };
  });
  fs.writeFileSync(path.join(dir, 'promote-manifest.json'), JSON.stringify({ schema: 'chatgpt-promote-manifest/1', notes }));
  return dir;
}

/** How many promoted notes a search opened (the manifest is not one of them). */
function noteReads(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((c) => path.basename(String(c[0])).startsWith('chatgpt-')).length;
}

describe('search_history keeps the tokens of promoted notes between queries', () => {
  const bodies = Array.from({ length: 30 }, (_, i) => `Lorem ipsum dolor sit amet ${i}. ${i % 3 === 0 ? 'alpha beta' : 'gamma delta'} lorem.`);

  it('a repeated identical query reads no promoted note again, and answers the same', () => {
    const dir = historyOf(bodies);
    const first = searchHistory(dir, 'lorem alpha', 20);
    expect(first.results.length).toBeGreaterThan(0);
    const read = vi.spyOn(fs, 'readFileSync');
    const second = searchHistory(dir, 'lorem alpha', 20);
    expect(noteReads(read)).toBe(0);
    expect(second).toEqual(first);
  });

  it('a note changed on disk is read again on the next query, so its new words are found', () => {
    const dir = historyOf(bodies);
    expect(searchHistory(dir, 'zebra', 5).results).toEqual([]);
    const changed = Buffer.from(noteText(4, 'a zebra is in this conversation now'));
    fs.writeFileSync(path.join(dir, 'chatgpt-4.md'), changed);
    const manifestPath = path.join(dir, 'promote-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.notes['chatgpt-4.md'].note_sha256 = crypto.createHash('sha256').update(changed).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const hits = searchHistory(dir, 'zebra', 5).results;
    expect(hits.map((h) => h.conversation_id)).toEqual(['conv-4']);
  });
});

describe('search_history keeps its cache within a fixed bound', () => {
  it('a history larger than the bound stays under it, and still answers as before', () => {
    // 20 notes of 1.2 MB: 24 MB of body text, above HISTORY_CACHE_CHARS (16 MB).
    const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(1_200_000 / 27));
    // The marker comes first: tokenize keeps only the first 20,000 tokens of a body.
    const bodies = Array.from({ length: 20 }, (_, i) => `marker${i} ${filler}`);
    const dir = historyOf(bodies);
    const first = searchHistory(dir, 'marker7', 5);
    expect(first.results.map((h) => h.conversation_id)).toEqual(['conv-7']);
    expect(historyCacheChars()).toBeLessThanOrEqual(HISTORY_CACHE_CHARS);
    expect(historyCacheChars()).toBeGreaterThan(0);
    expect(searchHistory(dir, 'marker7', 5)).toEqual(first);
  }, 60_000);
});
