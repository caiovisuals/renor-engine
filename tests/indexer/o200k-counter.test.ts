import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encode } from 'gpt-tokenizer';
import { countO200k, countO200kStrict } from '../../src/indexer/o200k';

// The counter replaces gpt-tokenizer in the running engine (it holds the vocabulary in ~4 MiB of typed arrays instead of
// ~45 MiB of Map), so the only acceptable difference between them is memory. gpt-tokenizer is the oracle here.

const oracle = (text: string): number => encode(text, { disallowedSpecial: new Set() }).length;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXED: string[] = [
  '', ' ', '\n', '\n\n\n', '\t\t  \r\n \r\n', 'x', 'x'.repeat(50),
  "Hello, world! It's a test.", "I'm you're they'll we've she'd HE'S", '1234567890 3.14159 1,000,000',
  'https://example.com/path?q=1&r=2#frag', 'function f(x){return x*2;}',
  'naïve café 日本語のテキスト 한국어 😀👍🏽 \u{1F9D1}‍\u{1F4BB}', '\u{10FFFF}\u{E0001}\u{1D400}',
  // byte-order marks: gpt-tokenizer drops a leading mark from a key that reads as text, and nine vocabulary entries start with one
  '﻿using System;\n', '﻿﻿namespace Foo', '﻿\n', '﻿\n\n', 'text ﻿출장안마',
  // lone surrogates have no spelling in the vocabulary
  'lone \uD800 high and \uDC00 low \uD83D', '\uD800', '\uDC00\uD800', 'a\uD83D',
  // special-token spellings are ordinary text unless the strict form is asked for
  '<|endoftext|> and <|im_start|>user<|im_end|>', '<|fim_prefix|><|fim_middle|><|fim_suffix|><|im_sep|><|endofprompt|>',
  'a\u0000b\u0001c\u007f\u0080\u009f', 'ǅ ǈ ǋ Ⅷ ½ ٣ ६ ０１２', 'ﬁ ﬂ ß İ ı', '̀́̂ é',
  ' '.repeat(40) + 'x' + ' '.repeat(40), 'ab'.repeat(300), '日本'.repeat(120),
];

describe('countO200k agrees with gpt-tokenizer', () => {
  it('on a fixed set of texts that exercise the vocabulary quirks', () => {
    for (const text of FIXED) expect(countO200k(text), JSON.stringify(text.slice(0, 40))).toBe(oracle(text));
  });

  it('on 4,000 seeded random texts built from every character class that has broken a tokenizer here', () => {
    const pools = [
      'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJ', '0123456789', ' \n\t\r', `.,;:!?()[]{}<>/\\|-_=+*&^%$#@~\`'"`,
      'éèñüßçøåæ', '日本語中文한국어', '😀😎🔥👍🏽🧑‍💻', '﻿​‍ ', '𐀀😀', '\uD800', '\uDC00',
      '̀́', '\u0000\u0001\u001f\u007f\u0080\u009f',
    ].map(p => Array.from(p));
    const r = rng(7);
    for (let i = 0; i < 4000; i++) {
      const n = 1 + Math.floor(r() * 60);
      let s = '';
      for (let k = 0; k < n; k++) {
        const pool = pools[Math.floor(r() * pools.length)];
        s += pool[Math.floor(r() * pool.length)];
        if (r() < 0.05) s += ' ';
      }
      const want = oracle(s);
      if (countO200k(s) !== want) throw new Error(`count differs for ${JSON.stringify(s)}: ${countO200k(s)} vs ${want}`);
    }
  });

  it('on the repository\'s own prose and code', async () => {
    const fs = await import('node:fs');
    for (const rel of ['../AGENTS.md', 'AGENTS.md', 'src/indexer/o200k.ts', 'src/mvp/server.ts']) {
      const file = path.resolve(__dirname, '../..', rel);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      expect(countO200k(text), rel).toBe(oracle(text));
    }
  });
});

describe('countO200kStrict refuses special-token spellings as gpt-tokenizer\'s default encode does', () => {
  it('counts ordinary text the same and throws the same error on a special spelling', () => {
    for (const text of ['plain text', 'ação 日本語', '']) expect(countO200kStrict(text)).toBe(encode(text).length);
    for (const text of ['x <|endoftext|> y', '<|im_start|>', 'a <|fim_suffix|> and <|endoftext|>']) {
      const want = (() => { try { encode(text); return 'no error'; } catch (e) { return (e as Error).message; } })();
      const got = (() => { try { countO200kStrict(text); return 'no error'; } catch (e) { return (e as Error).message; } })();
      expect(got).toBe(want);
      expect(want).toContain('Disallowed special token found');
    }
  });
});

describe('the packed vocabulary', () => {
  it('is what the generator writes from the installed gpt-tokenizer', () => {
    const res = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/tokenizer/gen-o200k.cjs'), '--check'], { encoding: 'utf8', timeout: 60_000 });
    expect(res.stdout + res.stderr).toContain('o200k.json is current');
    expect(res.status).toBe(0);
  });

  it('is not built until the first count', () => {
    const script = `
      const fs = require('node:fs');
      const loadedData = () => Object.keys(require.cache).some((k) => k.endsWith('o200k.json') || k.endsWith('o200k.json'));
      const mod = require(${JSON.stringify(path.resolve(__dirname, '../../dist/indexer/o200k.js'))});
      const afterImport = { loaded: mod.o200kLoaded(), data: loadedData(), gpt: Object.keys(require.cache).some((k) => k.includes('gpt-tokenizer')) };
      const n = mod.countO200k('a short note about cold starts');
      process.stdout.write(JSON.stringify({ afterImport, afterCount: { loaded: mod.o200kLoaded(), data: loadedData(), gpt: Object.keys(require.cache).some((k) => k.includes('gpt-tokenizer')) }, n }));
    `;
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
    if (res.status !== 0) throw new Error(`child failed (${res.status}): ${(res.stderr || '').slice(0, 500)}`);
    const out = JSON.parse(res.stdout);
    expect(out.afterImport).toEqual({ loaded: false, data: false, gpt: false });
    // built, and the packed file is not kept in the module cache afterwards
    expect(out.afterCount).toEqual({ loaded: true, data: false, gpt: false });
    expect(out.n).toBe(oracle('a short note about cold starts'));
  });
});
