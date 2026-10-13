import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_RULES, scanSecrets } from '../../src/extraction/secretScanner';
import { KEY_SHAPES, NATURAL_BENIGN, Rng, buildPlantedSet, buildRobustnessSet, password, plantedKey } from '../../scripts/eval/secret-guard/plantedSet';

/**
 * The tier-0 secret scanner (src/extraction/secretScanner.ts). Every secret here is planted and synthetic:
 * a seeded random string with a provider-like shape, built at run time, never a real credential and never a
 * key-shaped literal in this file. See docs/evals/results/SECRET-GUARD-TIER0-20261003.md for what was measured
 * on the investigation's own sets; the mirror sets used here are the same shapes from a different generator.
 */

const flag = (text: string) => {
  const f = scanSecrets(text);
  return f === null ? null : `${f.class}:${f.rule}`;
};

describe('provider keys', () => {
  // A bare run of hex or base64 has no prefix to recognise; it is caught only when the text names a key (see below).
  const BARE = new Set(['aws_secret', 'twilio', 'hex64']);

  for (const shape of Object.keys(KEY_SHAPES).filter(s => !BARE.has(s))) {
    it(`flags a ${shape} key in every sentence it is pasted into`, () => {
      const r = new Rng(101);
      for (let i = 0; i < 40; i++) {
        const { text, key } = plantedKey(shape, r);
        expect(flag(text), text.replace(key, '<key>')).toMatch(/^credential:/);
      }
    });
  }

  it('flags a bare token only when the text names a key, and not a git SHA or a low-entropy run', () => {
    const hex = '0123456789abcdef';
    expect(flag('bearer ' + hex.repeat(2))).toBe('credential:high-entropy-token'); // 32 characters, 4.0 bits each
    expect(flag('bearer ' + hex.repeat(4))).toBe('credential:high-entropy-token'); // 64
    expect(flag('value ' + hex.repeat(2))).toBeNull(); // nothing names a key
    expect(flag('bearer ' + hex.repeat(2) + hex.slice(0, 8))).toBeNull(); // 40 hex is a SHA-1 / git commit, left alone
    expect(flag('bearer ' + 'a'.repeat(32))).toBeNull(); // a long run with no entropy
  });

  it('documents the gap: a bare random token in a sentence that does not name a key is stored', () => {
    const r = new Rng(5);
    expect(flag(`Use ${KEY_SHAPES.twilio(r)} for the staging deploy, it should work.`)).toBeNull();
    expect(flag(`Use ${KEY_SHAPES.aws_secret(r)} for the staging deploy, it should work.`)).toBeNull();
  });

  it('flags a private key block and a JWT, and not a public key', () => {
    expect(flag('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('credential:private-key');
    expect(flag('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe('credential:private-key');
    expect(flag('-----BEGIN PUBLIC KEY-----')).toBeNull();
    expect(flag(`token ${KEY_SHAPES.jwt(new Rng(3))}`)).toMatch(/^credential:/);
  });
});

describe('URLs that carry a password', () => {
  const rule = SECRET_RULES.find(r => r.id === 'url-with-password')!;
  const viaRule = (text: string) => {
    for (const m of text.matchAll(rule.re)) if (rule.accept!(m[0], text, m.index)) return true;
    return false;
  };

  it('flags credentials in a URL and nothing else that looks like one', () => {
    expect(flag('DATABASE_URL=postgres://app:pw1234@db.example.com/app')).toBe('credential:url-with-password');
    expect(flag('redis://:pw1234@cache.example.com:6379')).toBe('credential:url-with-password');
    expect(flag('see https://example.com/path?x=1')).toBeNull();
    expect(flag('http://localhost:8080/path@x')).toBeNull();
    expect(flag('connect to host.example.com:5432/app')).toBeNull();
  });

  it('keeps the measured rule\'s edges: a lowercase scheme at a word boundary, and no more', () => {
    expect(flag('see.http://u:pw1234@h/')).toBe('credential:url-with-password'); // the scheme starts after the dot
    expect(flag('x_http://u:pw1234@h/')).toBeNull(); // "_" is a word character: no boundary
    expect(flag('POSTGRES://u:pw1234@db/app')).toBeNull(); // documented gap: an upper-case scheme is not recognised
  });

  it('accepts exactly the texts the measured pattern accepts (differential fuzz)', () => {
    // The measured rule was /\b[a-z][a-z0-9+.-]*:\/\/…/ ; the shipped one finds the literal "://" first and checks
    // the scheme behind it, because the original is quadratic on "a.a.a.a…". Same language, so same answers.
    const measured = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:[^\s@/]+@[^\s/]+/u;
    // A scheme-like run (letters of both cases, digits, the punctuation a scheme may hold, and characters that break
    // one), then "://" or a near miss, then a URL tail that is whole, cut short, or followed by a second URL.
    const schemeBits = ['a', 'b', 'z', 'Z', 'Q', '1', '9', '.', '+', '-', '_', ' ', '\n', 'é', '('];
    const tails = ['user:pw@host', ':pw@host', 'u:p@h', 'user:pw@', 'user@host', 'user:pw', '@:', 'u:p@h://d:e@f', 'u:p@h/x', 'u: p@h'];
    const r = new Rng(20261003);
    let positives = 0, negatives = 0;
    for (let i = 0; i < 30000; i++) {
      let text = '';
      for (let n = r.int(0, 9); n > 0; n--) text += r.pick(schemeBits);
      text += r.next() < 0.92 ? '://' : r.pick([':/', '//', ':']);
      text += r.pick(tails);
      if (r.next() < 0.3) for (let n = r.int(1, 4); n > 0; n--) text += r.pick(schemeBits);
      const expected = measured.test(text);
      if (expected) positives++; else negatives++;
      expect(viaRule(text), JSON.stringify(text)).toBe(expected);
    }
    // the fuzz reaches both answers often enough to mean something
    expect(positives).toBeGreaterThan(1000);
    expect(negatives).toBeGreaterThan(1000);
  });
});

describe('credentials stated in words', () => {
  const r = new Rng(77);
  const p = () => password(r);

  it('flags a cue word, a connector and a value', () => {
    const cases = [
      `my wifi password is ${p()}`,
      `The password for the NAS admin is ${p()}`,
      `login: ${r.pick(['ana', 'bob'])}.${r.pick(['maple', 'orbit'])} / password: ${p()}`,
      'my bank PIN is 4821',
      'backup recovery code: ab12-cd34-ef56-gh78',
      'my wallet seed phrase: maple orbit canyon velvet harbor copper lantern meadow falcon quartz ember willow',
      '2FA backup codes: 1234-5678, 2345-6789, 3456-7890, 4567-8901',
      'the safe combination is 482913',
      `Senha do wifi: ${p()}`,
      `remember that the router admin password is ${p()}`,
    ];
    for (const text of cases) expect(flag(text), text).toBe('credential:credential-in-words');
  });

  it('takes the cue as a whole word, so "pin" in "shopping" is not a cue, and still reads WIFI_PASSWORD and plurals', () => {
    for (const text of [
      'Online shopping is so much more convenient than going to the mall.',
      'My opinion is that tabs beat spaces, but I follow the repo.',
      'I have been meal prepping on Sundays so lunch is ready for the week.',
      'I am helping out at the food bank every second Saturday.',
      'the pinned message is important today',
      'Keeping up with the latest episodes is hard with my schedule.',
    ]) expect(flag(text), text).toBeNull();
    expect(flag(`WIFI_PASSWORD=${p()}`)).toBe('credential:credential-in-words');
    expect(flag(`admin_pin: 482913`)).toBe('credential:credential-in-words');
    expect(flag(`the passwords are ${p()} and ${p()}`)).toBe('credential:credential-in-words');
  });

  it('documents what the whole-word cue gives up: a cue glued into a longer word or a camelCase name', () => {
    expect(flag('mypin is 4821')).toBeNull();
    expect(flag('dbPassword = hunter2abc')).toBeNull();
  });

  it('documents the gaps and the false positives that are inherent to a cue word and a value', () => {
    expect(flag('the door code for the office is 482913#')).toBeNull(); // no cue word
    expect(flag('the secret is amazing, honestly')).toBe('credential:credential-in-words');
    expect(flag('my login is slow today')).toBe('credential:credential-in-words');
    expect(flag('a combination of factors is involved')).toBe('credential:credential-in-words');
  });
});

describe('personal identifiers', () => {
  it('flags a Luhn-valid card, an email, an SSN, a passport number, a National Insurance number and common phones', () => {
    expect(flag('card 4242424242424242 expires soon')).toBe('identifier:payment-card');
    expect(flag('card 4242 4242 4242 4242 expires soon')).toBe('identifier:payment-card');
    expect(flag('write to jo.doe@example.com')).toBe('identifier:email');
    expect(flag('write to josé@example.com')).toBe('identifier:email');
    expect(flag('My SSN is 923-45-6789 ok')).toBe('identifier:national-id');
    expect(flag('passport number X1234567 issued')).toBe('identifier:national-id');
    expect(flag('NI QQ 12 34 56 C')).toBe('identifier:national-id');
    expect(flag('Call me on +1 (415) 555-0159 tonight.')).toBe('identifier:phone');
    expect(flag('Call me on 415-555-0192 tonight.')).toBe('identifier:phone');
    expect(flag('Call me on (21) 99999-0818 tonight.')).toBe('identifier:phone');
  });

  it('caps the local part of an email at 64 characters without changing which texts match (differential fuzz)', () => {
    // The measured pattern had no cap. A match needs one character in front of the "@" and no more, so the cap only
    // stops a long word-only text from being scanned quadratically.
    const rule = SECRET_RULES.find(r => r.id === 'email')!;
    const measured = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/u;
    const local = ['a', 'é', '1', '_', '.', '+', '-', ' ', '\n', 'x'.repeat(70), 'ab', '!', '/'];
    const domain = ['a', 'é', '1', '_', '-', '.', '.com', 'co.uk', 'x'.repeat(70), ' ', '@', '/'];
    const r = new Rng(424242);
    let positives = 0, negatives = 0;
    for (let i = 0; i < 30000; i++) {
      let text = '';
      for (let n = r.int(0, 6); n > 0; n--) text += r.pick(local);
      text += r.next() < 0.92 ? '@' : r.pick(['@@', ' @', '']);
      for (let n = r.int(0, 6); n > 0; n--) text += r.pick(domain);
      const expected = measured.test(text);
      if (expected) positives++; else negatives++;
      expect(text.search(rule.re) >= 0, JSON.stringify(text)).toBe(expected);
    }
    expect(positives).toBeGreaterThan(1000);
    expect(negatives).toBeGreaterThan(1000);
  });

  it('does not flag a Luhn-invalid card number, a date, an ISBN, or a bare host name', () => {
    expect(flag('card 4242424242424241 expires soon')).toBeNull();
    expect(flag('The meeting is on 2026-10-03 at noon.')).toBeNull();
    expect(flag('ISBN 978-3-16-148410-0 is the one')).toBeNull();
    expect(flag('user@localhost')).toBeNull();
  });

  it('documents the gaps and false positives: a UK mobile is stored, an invoice number is refused', () => {
    expect(flag('Call me on +44 7700 900108 tonight.')).toBeNull();
    expect(flag('Invoice 2023-4567-8901 is due on the 15th.')).toBe('identifier:phone');
  });
});

describe('benign text', () => {
  const set = buildPlantedSet();
  // A placeholder and an invoice number are the measured scanner's two kinds of false positive; everything else is quiet.
  const KNOWN_FALSE_POSITIVES = new Set(['benign:placeholder', 'benign:tracking']);

  it('stores every SHA, UUID, checksum, data URI, address, sentence about secrets, number and name in the set', () => {
    const quiet = set.filter(it => it.gold === 'store' && !KNOWN_FALSE_POSITIVES.has(it.kind));
    expect(quiet.length).toBeGreaterThan(100);
    for (const it of quiet) expect(flag(it.text), `${it.kind}: ${it.text}`).toBeNull();
  });

  it('stores every everyday sentence, among them the ones that carry a cue word inside another word', () => {
    expect(NATURAL_BENIGN.length).toBe(30);
    for (const text of NATURAL_BENIGN) expect(flag(text), text).toBeNull();
  });

  it('documents the false positives: a masked or placeholder value looks like a credential', () => {
    expect(flag('password: ******** in the screenshot, so nothing leaks.')).toBe('credential:credential-in-words');
    expect(flag('Set OPENAI_API_KEY=YOUR_API_KEY_HERE in the .env file before running.')).toBe('credential:credential-in-words');
  });

  it('stores empty and blank text', () => {
    expect(scanSecrets('')).toBeNull();
    expect(scanSecrets('   \n\t ')).toBeNull();
  });
});

describe('what a finding holds', () => {
  it('is a class and a rule label from the table, never text from the input', () => {
    const labels = new Set(SECRET_RULES.map(r => r.id));
    for (const it of buildPlantedSet().filter(i => i.gold !== 'store')) {
      const f = scanSecrets(it.text);
      if (f === null) continue;
      expect(Object.keys(f).sort()).toEqual(['class', 'rule']);
      expect(labels.has(f.rule)).toBe(true);
      expect(['credential', 'identifier']).toContain(f.class);
      // belt and braces on top of the two checks above: the random tail of a secret is not in what came back
      for (const secret of it.secrets) if (secret.length >= 12) expect(JSON.stringify(f)).not.toContain(secret.slice(-12));
    }
  });

  it('gives a credential the verdict when a text holds a credential and an identifier', () => {
    expect(flag('email me at jo.doe@example.com, the password is Maple-orbit-4821')).toMatch(/^credential:/);
  });
});

describe('state and determinism', () => {
  it('gives the same answer for the same text, whatever was scanned before it', () => {
    const r = new Rng(9);
    const bad = plantedKey('github', r).text;
    const cardText = 'card 4242424242424242';
    const quiet = 'I moved to Lisbon in March and I work near the river.';
    const first = [flag(bad), flag(cardText), flag(quiet)];
    for (let i = 0; i < 50; i++) expect([flag(bad), flag(cardText), flag(quiet)]).toEqual(first);
    for (let i = 0; i < 50; i++) expect([flag(quiet), flag(cardText), flag(bad)]).toEqual([first[2], first[1], first[0]]);
  });

  it('leaves no match position behind on any shared regex', () => {
    for (const it of buildPlantedSet()) scanSecrets(it.text);
    for (const rule of SECRET_RULES) expect(rule.re.lastIndex, rule.id).toBe(0);
  });

  it('writes every rule as a global, Unicode-aware regex (matchAll walks a copy; \\p{L} needs the u flag)', () => {
    for (const rule of SECRET_RULES) {
      expect(rule.re.flags, rule.id).toContain('g');
      expect(rule.re.flags, rule.id).toContain('u');
    }
  });
});

describe('hostile text', () => {
  // Characters that break parsers are built, never typed: a raw U+2028 in a source file is a line break to an editor.
  const cu = (...codes: number[]) => String.fromCharCode(...codes);

  it('never throws, whatever it holds, and still sees a credential next to it', () => {
    const texts = [
      cu(0xd800), cu(0xdc00, 0x41), `a${cu(0xd83d)}b`, // lone surrogates
      `${cu(0)}password: abcd1234`, // NUL
      `${cu(0x2028)}pin is 4821${cu(0x2029)}`, // line and paragraph separators
      `${cu(0x202e)}password is abcd1234`, // right-to-left override
      `password${cu(0x200b)} is abcd1234`, // zero-width space inside the cue
      '😀'.repeat(3000) + ' sk-' + 'a'.repeat(30),
      '\n'.repeat(5000), 'x'.repeat(100000), `${cu(0x85)}token: abcd1234`,
    ];
    for (const text of texts) expect(() => scanSecrets(text), JSON.stringify(text.slice(0, 20))).not.toThrow();
    expect(flag(`${cu(0)}password: abcd1234`)).toMatch(/^credential:/);
    expect(flag(`${cu(0x202e)}password is abcd1234`)).toMatch(/^credential:/);
    expect(flag('😀'.repeat(3000) + ' sk-' + 'a'.repeat(30))).toBe('credential:api-key');
  });

  it('documents the gap: a zero-width character inside a cue word hides it, and after the word it changes nothing', () => {
    expect(flag(`pass${cu(0x200b)}word is abcd1234`)).toBeNull();
    expect(flag(`password${cu(0x200b)} is abcd1234`)).toMatch(/^credential:/);
  });
});

describe('cost', () => {
  // The scanner runs on the write path, on text up to 8192 characters (the longest field `remember` admits).
  // These are the shapes that make a naive pattern quadratic. Measured on this scanner: about 30 ms of CPU for each
  // at 64 K characters; the pattern this one replaced took 15 s on "a.a.a.a…" at that size. CPU time, not wall time,
  // so a busy host does not move it. The budget is generous on purpose: it separates linear from quadratic.
  const mk = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const shapes: Record<string, (n: number) => string> = {
    'a.a.a.': n => mk('a.', n),
    'a@a@a@': n => mk('a@', n),
    'one long word': n => mk('a', n),
    'password password': n => mk('password ', n),
    'pin then spaces': n => 'pin' + mk(' ', n),
    'sk-sk-sk-': n => mk('sk-', n),
    'eyJeyJeyJ': n => mk('eyJ', n),
    '-----BEGIN ': n => mk('-----BEGIN ', n),
    'digits': n => mk('1', n),
    'digit space': n => mk('1 ', n),
    'digit dash': n => mk('1-', n),
    'alnum run with a cue': n => 'key ' + mk('a0', n),
    'long word then @': n => mk('x', n - 1) + '@',
    'long scheme then ://': n => mk('a', n - 3) + '://',
    'dotted scheme then a URL': n => mk('a.', n - 12) + '://u:p@h/',
    'phone-like': n => mk('415-555-0123 ', n),
    'uuid run': n => mk('0123abcd-0123-4567-89ab-0123456789ab ', n),
    'is is is': n => mk('this is ', n),
  };
  const cpuMs = (fn: () => void) => {
    const before = process.cpuUsage();
    fn();
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  };

  for (const [name, make] of Object.entries(shapes)) {
    it(`scans ${name} in linear time`, () => {
      const text = make(65536);
      scanSecrets(make(4096)); // warm the regex engine
      expect(cpuMs(() => scanSecrets(text))).toBeLessThan(1000);
    });
  }
});

describe('what was measured, pinned on the mirror sets', () => {
  // The mirror sets are deterministic (seeded), so these are exact. They are not the investigation's numbers (94.2 %
  // and 4.5 % on its sets; see the results doc): a different generator, and 30 natural sentences against its 100.
  // They are here so that a change to the scanner is a visible edit to this block, not a silent drift.
  const verdicts = (items: ReturnType<typeof buildPlantedSet>) => {
    const missed: Record<string, number> = {};
    const falseBlocks: Record<string, number> = {};
    let caught = 0, planted = 0, benign = 0;
    for (const it of items) {
      const flagged = scanSecrets(it.text) !== null;
      if (it.gold === 'store') { benign++; if (flagged) falseBlocks[it.kind] = (falseBlocks[it.kind] ?? 0) + 1; }
      else { planted++; if (flagged) caught++; else missed[it.kind] = (missed[it.kind] ?? 0) + 1; }
    }
    return { caught, planted, benign, missed, falseBlocks };
  };

  it('catches 222 of the 243 planted secrets and refuses 12 of 130 benign texts', () => {
    expect(verdicts(buildPlantedSet())).toEqual({
      caught: 222, planted: 243, benign: 130,
      missed: { 'key:twilio': 3, 'key:hex64': 1, nl_credential: 13, pii_phone: 4 },
      falseBlocks: { 'benign:tracking': 5, 'benign:placeholder': 7 },
    });
  });

  it('catches 55 of the 60 robustness secrets and refuses none of the 10 long benign texts', () => {
    expect(verdicts(buildRobustnessSet())).toEqual({
      caught: 55, planted: 60, benign: 10,
      missed: { 'obfuscated:spaced': 4, 'obfuscated:split': 1 },
      falseBlocks: {},
    });
  });

  it('ignores text that tries to talk the scanner into storing a secret', () => {
    const injections = buildRobustnessSet().filter(it => it.kind === 'injection');
    expect(injections).toHaveLength(20);
    for (const it of injections) expect(flag(it.text), it.text.slice(0, 60)).not.toBeNull();
  });
});

describe('what the scanner reads', () => {
  // The guard is switched by one variable and the scanner by none: a second switch would be a second way to skip it.
  const SRC = path.resolve(__dirname, '../../src/extraction');
  const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');
  // the import path's screen is the one other module the guard added to src/
  const readImportScreen = () => fs.readFileSync(path.resolve(__dirname, '../../src/importing/secretScreen.ts'), 'utf8');
  const envNames = (src: string) => [...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|\benv\.([A-Z][A-Z0-9_]*)|\benv\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g)].map(m => m[1] ?? m[2] ?? m[3]);

  it('reads no environment variable in the scanner or the import screen', () => {
    expect(envNames(read('secretScanner.ts'))).toEqual([]);
    expect(envNames(readImportScreen())).toEqual([]);
  });

  it('reads one environment variable in the guard, RENOR_SECRET_GUARD, and only to switch the guard on', () => {
    expect(envNames(read('secretGuard.ts'))).toEqual(['RENOR_SECRET_GUARD']);
  });

  it('sends nothing anywhere: no outside model, no network, no process, and only its own two imports', () => {
    const importsOf = (src: string) => [...src.matchAll(/^import\b[\s\S]*?\bfrom '([^']+)';/gm)].map(m => m[1]).sort();
    expect(importsOf(read('secretScanner.ts'))).toEqual([]);
    expect(importsOf(read('secretGuard.ts'))).toEqual(['./decision-model', './secretScanner']);
    // the decision-model module the guard builds on is the local-rules default: no network either
    // (classify_capture checks the same scanner first, so it imports it too)
    expect(importsOf(read('decision-model.ts'))).toEqual(['../context/rowStore', './secretScanner']);
    // the import screen builds on the guard and the plan's types, and nothing else
    expect(importsOf(readImportScreen())).toEqual(['../extraction/secretGuard', './plan']);
    const sources: Array<[string, string]> = [
      ['secretScanner.ts', read('secretScanner.ts')], ['secretGuard.ts', read('secretGuard.ts')], ['secretScreen.ts', readImportScreen()],
    ];
    for (const [file, source] of sources) {
      // comments say "no network", so look at the code only
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|child_process|spawn|exec|http|https|net|dgram|dns)\b\s*[(.'"]/);
    }
  });
});
