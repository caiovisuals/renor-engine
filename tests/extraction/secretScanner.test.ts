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
    expect(flag('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----')).toBe('credential:private-key');
    expect(flag('-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe('credential:private-key');
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

  it('leaves an example password alone: a placeholder, "password", a one-letter or a variable', () => {
    for (const pw of ['p', 'pw', 'password', 'PASSWORD', 'changeme', 'xxxxxxxx', '********', '<password>', '${DB_PASSWORD}', '$DB_PASSWORD', '...', 'user']) {
      expect(flag(`postgres://app:${pw}@db.example.com/app`), pw).toBeNull();
    }
    expect(flag('postgres://app:Hunter2-Bench@db.example.com/app')).toBe('credential:url-with-password');
    expect(flag('mysql://root:$BuDWjRA72axKt@db.example.com/shop')).toBe('credential:url-with-password'); // a "$" in a real password is not a variable
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
    // Passwords are four characters or more: since 2026-10-13 the rule leaves a one-letter or placeholder password alone (see below).
    const tails = ['user:pw1234@host', ':pw1234@host', 'u:p1234@h', 'user:pw1234@', 'user@host', 'user:pw1234', '@:', 'u:p1234@h://d:e1234@f', 'u:p1234@h/x', 'u: p1234@h'];
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
      'SEED my wallet seed phrase: maple orbit canyon velvet harbor copper lantern meadow falcon quartz ember willow',
      'BACKUP 2FA backup codes: 1234-5678, 2345-6789, 3456-7890, 4567-8901',
      'the safe combination is 482913',
      `Senha do wifi: ${p()}`,
      `remember that the router admin password is ${p()}`,
    ];
    // A seed phrase and a list of backup codes are their own rules: the value is the whole list, not its first word.
    for (const text of cases) {
      const own = text.startsWith('SEED ') ? 'credential:seed-phrase' : text.startsWith('BACKUP ') ? 'credential:backup-codes' : 'credential:credential-in-words';
      expect(flag(text.replace(/^(SEED|BACKUP) /, '')), text).toBe(own);
    }
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

  it('takes the connector as a whole word: "this" and "Island" do not connect a cue to a value, and Portuguese "é" does', () => {
    expect(flag('Keep the literal token abc---xyz in this note.')).toBeNull();
    expect(flag('the password manager Island-maple-2606 is in the vault')).toBeNull();
    expect(flag('minha senha do banco é Island-maple-2606')).toBe('credential:credential-in-words');
  });

  it('documents what the whole-word cue gives up: a cue glued into a longer word or a camelCase name', () => {
    expect(flag('mypin is 4821')).toBeNull();
    expect(flag('dbPassword = hunter2abc')).toBeNull();
  });

  it('documents the gaps that are inherent to a cue word and a value', () => {
    expect(flag('the door code for the office is 482913#')).toBeNull(); // no cue word
    expect(flag('the wifi password is sunshine')).toBeNull(); // a plain word after "password is" reads the same as "password is required"
    expect(flag('my password is banana')).toBeNull();
  });

  it('no longer refuses a cue word followed by prose (the false positives of the measured rule, 2026-10-13)', () => {
    for (const text of [
      'the secret is amazing, honestly',
      'my login is slow today',
      'a combination of factors is involved',
      'The API key is rotated every 90 days; the rotation runbook is in docs/ops.',
      'The token budget is 4000 tokens per request.',
      'Password: required, minimum 12 characters.',
      'token = process.env.GITHUB_TOKEN',
      'Meu pin é muito fácil de lembrar, então vou trocar depois.',
    ]) expect(flag(text), text).toBeNull();
  });

  it('refuses a mixed-symbol password whatever symbol it holds: "=", braces, a backslash, "$", "&" (review of PR 605, round 2)', () => {
    for (const text of [
      'password: Abc=1234', 'password: Abc{1234}', 'password: Abc}1234', 'password: Abc\\1234', 'password: {Abc1234', 'password: Abc$1234', 'password is Abc&1234',
      'the staging password is Tr0ub4dor&3', 'my wifi password is Hunter{2}-Bench',
    ]) expect(flag(text), text).toBe('credential:credential-in-words');
  });

  // One generated case per printable ASCII symbol (32 of them), digit-free and with digits (review of PR 605, round 3).
  const SYMBOLS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).filter(c => /[^A-Za-z0-9 ]/.test(c));

  it('refuses a password with any one of the 32 printable symbols inside it, with or without digits', () => {
    expect(SYMBOLS).toHaveLength(32);
    for (const sym of SYMBOLS) {
      for (const text of [`password: abc${sym}def`, `password is abc${sym}def`, `my wifi password = abc${sym}def`, `password: abc${sym}1234`, `Senha: abc${sym}def`, `passphrase: abc${sym}def`]) {
        expect(flag(text), text).toBe('credential:credential-in-words');
      }
    }
  });

  it('after a token, secret or key cue the symbols a generated secret holds count (! @ # $ % ^ & * + = / ~ ?), the ones code and prose are made of do not', () => {
    const counted = '!@#$%^&*+=/~?';
    for (const cue of ['token', 'secret', 'api key']) {
      for (const sym of SYMBOLS) {
        const text = `${cue}: abc${sym}def`;
        // a "/" joins two plain words into a path, which is code: only a mixed-case or digit value after "/" is a secret
        if (counted.includes(sym) && sym !== '/') expect(flag(text), text).toBe('credential:credential-in-words');
        else expect(flag(text), text).toBeNull();
      }
    }
  });

  it('refuses a password that merely CONTAINS template, query or path syntax (review of PR 605, round 4)', () => {
    for (const text of [
      'password: abc${def', 'password: abc${def}ghi', 'password: abc$(def)ghi', 'password: abc=123&def=456', 'password: C:\\Abc1234',
      'password: pre${VAR}', 'token=abc123def&x=1',
      // an unbalanced delimiter is not a template (review of PR 605, round 5)
      'password: ${Abc1234', 'password: $(Abc1234', 'password: {{Abc1234', 'password: {{Abc1234}', 'password: ${Abc1234 and more', 'password: $(Abc1234 then', 'password: ${DB_PASSWORD', 'password: $DB_PASSWORD}', 'password: ${DB_PASSWORD}}', 'password: ${DB}xK9mQ2', 'password: {{name}}Zq8Lm2', 'password: $(cmd)Zq8Lm2', 'password: C:\\Users' + '\\Zq8Lm2Vn7Rt4',
    ]) expect(flag(text), text).toBe('credential:credential-in-words');
  });

  it('accepts a template only when the whole delimited expression is plain; unrelated text before the closing delimiter is a password (review of PR 605, round 6)', () => {
    for (const text of [
      'password: ${Abc1234 and an unrelated brace appears later }', 'password: $(Abc1234 and an unrelated parenthesis appears later )',
      'password: {{Abc1234 and unrelated braces appear later }}', 'password: ${Zq8Lm2Vn7Rt4 }', 'password: $(Abc1234 | tee out )', 'password: ${Abc1234 $(x) }',
      'password: ${abcd ' + 'word '.repeat(12) + '}', 'password: {{Abc1234 x }}',
    ]) expect(flag(text), text).toBe('credential:credential-in-words');
    for (const text of ['SECRET="$(openssl rand -hex 32)"', 'password: $(cat /run/secret)', 'password: ${A:-x y}', 'password: $(git rev-parse --short HEAD)']) expect(flag(text), text).toBeNull();
  });

  it('judges a password written in any script like one written in Latin letters (review of PR 605, round 6)', () => {
    for (const text of [
      'password: пароль123', 'password: Пароль-Секрет7', 'senha: Ключ#2024', 'password: κωδικός123', 'password: كلمة١٢٣٤٥٦', 'password: пароль#Ключ', 'password: ПарольСекрет',
      'with password Пароль-9232abc you can log in',
    ]) expect(flag(text), text).toBe('credential:credential-in-words');
    for (const text of ['the token is случайный', 'the secret is пароль', 'the token is task-queue-ключ', 'The API key is rotated every 90 days', 'the api key is ротируется']) expect(flag(text), text).toBeNull();
  });

  it('stores a value that IS one template placeholder, a call, a query of placeholders, or a path with no secret-shaped segment', () => {
    for (const text of [
      'password: ${DB_PASSWORD}', 'password: ${MAX_TOKENS:-60000}', 'password: {{db_password}}', 'password: $(cat /run/secret)', 'password: $DB_PASSWORD',
      'password: C:\\Users\\user\\secrets', 'SECRET="$(openssl rand -hex 32)"', 'token_hash = sha256(raw_token)', "PASSWORD: randomBytes(18).toString('hex')",
      'password: ?user=${USER}&token=${TOKEN}', 'password: ${A:-x y}', 'password: {{ name }}', 'token: $(cat /x)',
    ]) expect(flag(text), text).toBeNull();
  });

  it('refuses a password holding two or three symbols together, whichever they are (1,024 pairs and 4,000 seeded triples)', () => {
    const r = new Rng(605);
    const cases: string[] = [];
    for (const a of SYMBOLS) for (const b of SYMBOLS) cases.push(`password: ab${a}${b}cd`);
    for (let i = 0; i < 4000; i++) cases.push(`password: ab${r.pick(SYMBOLS)}${r.pick(SYMBOLS)}${r.pick(SYMBOLS)}cd`);
    const stored = cases.filter(t => !flag(t));
    expect(stored).toEqual([]);
    for (const t of ['password is ab{}cd', 'my password = ab$(}cd', 'Senha: ab\\\\cd', 'passphrase: ab=&=cd']) expect(flag(t), t).toBe('credential:credential-in-words');
  });

  it('reads words joined by a hyphen after a password cue as a passphrase, and after any other cue as a name', () => {
    expect(flag('password: correct-horse')).toBe('credential:credential-in-words');
    expect(flag('the token is task-queue-handler')).toBeNull();
    expect(flag('the secret is amazing-grace')).toBeNull();
    expect(flag("MVP_OWNER_PASSWORD='<owner-secret>'")).toBeNull(); // a placeholder, though its words are hyphen-joined
  });

  it('still refuses the value when it looks like one: letters with digits or symbols, a PIN, a long random token', () => {
    for (const text of [
      'my password is hunter2', 'password: Violet-maple-6705', 'the staging password is Tr0ub4dor&3', 'with password Falcon-meadow-9232 you can log in',
      'my pin is 4821', 'the passphrase: correct-Horse-battery-staple9', 'password: correct-horse', 'the wifi password is correct_horse_battery', 'my api\tkey is Zq8Lm2Vn7Rt4Xw9Bc3Hd6Ky',
      'password for the staging database account used by the nightly deploy bot is Hunter2-Bench-Staging',
    ]) expect(flag(text), text).toBe('credential:credential-in-words');
  });
});

describe('personal identifiers', () => {
  it('flags a Luhn-valid card with a real issuer, an SSN, a passport number, a National Insurance number and phones written like phones', () => {
    expect(flag('card 4242424242424242 expires soon')).toBe('identifier:payment-card');
    expect(flag('card 4242 4242 4242 4242 expires soon')).toBe('identifier:payment-card');
    expect(flag('My SSN is 923-45-6789 ok')).toBe('identifier:national-id');
    expect(flag('passport number X1234567 issued')).toBe('identifier:national-id');
    expect(flag('NI QQ 12 34 56 C')).toBe('identifier:national-id');
    expect(flag('Call me on +1 (415) 555-0159 tonight.')).toBe('identifier:phone');
    expect(flag('Call me on 415-555-0192 tonight.')).toBe('identifier:phone');
    expect(flag('Call me on (21) 99999-0818 tonight.')).toBe('identifier:phone');
  });

  it('allows email addresses (owner decision 2026-10-13, "guard option b")', () => {
    for (const text of ['write to jo.doe@example.com', 'write to josé@example.com', 'Contact: maria@example.com', 'support@example.com', 'cc ana.silva@empresa.com.br on the thread']) {
      expect(flag(text), text).toBeNull();
    }
    expect(SECRET_RULES.some(r => r.id === 'email')).toBe(false);
    // an address inside a URL that carries a password is still the password's business
    expect(flag('postgres://app:Hunter2-Bench@db.example.com/app')).toBe('credential:url-with-password');
  });

  it('refuses a card only with a real issuer prefix and length, and not glued into a longer token', () => {
    for (const n of ['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117', '4222222222222']) expect(flag(`card ${n} expires soon`), n).toBe('identifier:payment-card');
    // every Discover range with its boundaries, and Diners and UnionPay (review of PR 605, round 6)
    for (const n of ['6440000000000005', '6490000000000004', '6500000000000002', '6221260000000000', '6229250000000003', '6011000000000004', '6440000000000000002', '30569000000008', '36000000000008', '6200000000000005']) {
      expect(flag(`card ${n} expires soon`), n).toBe('identifier:payment-card');
    }
    for (const n of ['6430000000000007']) expect(flag(`card ${n} expires soon`), n).toBeNull(); // Luhn-valid, 643 is no issuer's
    expect(flag('card 4111 1111 1111 1111 expires soon')).toBe('identifier:payment-card');
    expect(flag('card 4111-1111-1111-1111 expires soon')).toBe('identifier:payment-card');
    // Luhn-valid but no issuer uses that prefix: a 14-digit migration timestamp and a 16-digit order id
    expect(flag('migration 20260923180000 applied')).toBeNull();
    expect(flag('order 9999999999999995 shipped')).toBeNull();
    // glued into a name, a path or a longer number
    expect(flag('file-4111111111111111.log')).toBeNull();
    expect(flag('/var/data/4111111111111111/x')).toBeNull();
    expect(flag('id4111111111111111')).toBeNull();
  });

  it('refuses a national id: SSN, CPF, passport, National Insurance', () => {
    expect(flag('My SSN is 923-45-6789 ok')).toBe('identifier:national-id');
    expect(flag('CPF 123.456.789-09 do titular')).toBe('identifier:national-id');
    expect(flag('passport number X1234567 issued')).toBe('identifier:national-id');
    expect(flag('NI QQ 12 34 56 C')).toBe('identifier:national-id');
  });

  it('refuses a phone number written like one, and not a bare run of digits', () => {
    for (const t of ['+55 11 91234-5678', '+44 7700 900123', '+1 (415) 555-0159', '(415) 555-0132', '415-555-0132', '(21) 99999-0818', '0800 123 4567']) {
      expect(flag(`Call me on ${t} tonight.`), t).toBe('identifier:phone');
    }
    for (const t of ['at=1791875632', 'call on 1791875632', 'order 1234567890', '?id=1234567890', '1791875632000', 'ticket 48213']) {
      expect(flag(t), t).toBeNull();
    }
  });

  it('does not flag a Luhn-invalid card number, a date, an ISBN, or a bare host name', () => {
    expect(flag('card 4242424242424241 expires soon')).toBeNull();
    expect(flag('The meeting is on 2026-10-03 at noon.')).toBeNull();
    expect(flag('ISBN 978-3-16-148410-0 is the one')).toBeNull();
    expect(flag('user@localhost')).toBeNull();
  });

  it('documents the false positive: an invoice number written like a phone number is refused', () => {
    expect(flag('Call me on +44 7700 900108 tonight.')).toBe('identifier:phone'); // a UK mobile is a phone number since 2026-10-13
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

  it('stores a masked or placeholder value: it is not a credential (2026-10-13; the measured rule refused both)', () => {
    expect(flag('password: ******** in the screenshot, so nothing leaks.')).toBeNull();
    expect(flag('Set OPENAI_API_KEY=YOUR_API_KEY_HERE in the .env file before running.')).toBeNull();
    expect(flag('token: <redacted>')).toBeNull();
    expect(flag('secret = ${SECRET_FROM_VAULT}')).toBeNull();
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
    expect(flag('😀'.repeat(3000) + ' sk-' + 'Fk3vQ9pLm2RtX8wZ4hYc7NbE')).toBe('credential:api-key');
  });

  it('a zero-width character inside a cue word does not hide it, and after the word it changes nothing', () => {
    expect(flag(`pass${cu(0x200b)}word is abcd1234`)).toMatch(/^credential:/);
    expect(flag(`password${cu(0x200b)} is abcd1234`)).toMatch(/^credential:/);
  });
});

describe('invisible characters, line breaks and full-width letters inside a key (the fold before the rules)', () => {
  const ch = (...codes: number[]) => String.fromCodePoint(...codes);
  const KEY = 'sk-proj-' + new Rng(401).str(28);
  const JWT = KEY_SHAPES.jwt(new Rng(31));

  it('still finds a key with a zero-width space, word joiner, soft hyphen, zero-width joiner or byte-order mark inside it', () => {
    for (const c of [0x200b, 0x2060, 0xad, 0x200d, 0xfeff]) {
      const broken = KEY.slice(0, 9) + ch(c) + KEY.slice(9);
      expect(flag(`OpenAI key for the bench job: ${broken}`), `U+${c.toString(16)}`).toBe('credential:api-key');
    }
    expect(flag(`token for the bench job: ${JWT.replace('.', '.' + ch(0x200b))}`)).toBe('credential:jwt');
  });

  it('finds a key broken by a line break or a space, when each piece holds a digit or a symbol', () => {
    expect(flag(`OpenAI key for the bench job: sk-proj-Fk3vQ9\npLm2RtX8wZ4hYc7NbE`)).toBe('credential:api-key');
    expect(flag(`OpenAI key for the bench job: sk-proj-Fk3vQ9 pLm2RtX8wZ4hYc7NbE`)).toBe('credential:api-key');
    expect(flag(`OpenAI key for the bench job: sk-proj-Fk3vQ9\r\n${ch(0x200b)}pLm2RtX8wZ4hYc7NbE`)).toBe('credential:api-key');
    expect(flag(`sandbox for the bench job: ${JWT.slice(0, 30)}\n${JWT.slice(30)}`)).toBe('credential:jwt');
  });

  it('reads a full-width key as the ASCII key it spells (NFKC)', () => {
    expect(flag('OpenAI key for the bench job: ｓｋ-ｐｒｏｊ-Fk3vQ9pLm2RtX8wZ4hYc7NbE')).toBe('credential:api-key');
  });

  it('does not join ordinary prose into a key: a piece without a digit or a symbol is not joined', () => {
    for (const text of [
      'the sk-learn tutorial is good for the whole team',
      'deploy the 2026 pipeline on the staging cluster today',
      'the hf_model directory is in the cache, see the notes',
      'my npm_run build script is in the repo root folder',
      'the migration ran at 10:02 and the batch passed on the first try',
      // A list of words that each hold a digit or a symbol: the join stops after a few pieces, so a version list is not a key.
      'sk-learn v2_0 v3_0 v4_0 v5_0',
      'sk-learn v2_0 v3_0 v4_0 v5_0 v6_0 v7_0 v8_0',
    ]) expect(flag(text), text).toBeNull();
  });

  it('a stray "=" before a split key does not use up its joins, and a zero-width space before the prefix does not hide the key', () => {
    expect(flag('value = sk-proj-F1 a2b3 c4d5 e6f7g8h9')).toBe('credential:api-key');
    expect(flag('value\u200Bsk-proj-' + 'Fk3vQ9pLm2RtX8wZ4hYc7NbE')).toBe('credential:api-key');
    expect(flag('OpenAI key for the bench job:\u200Bsk-proj-' + 'Fk3vQ9pLm2RtX8wZ4hYc7NbE')).toBe('credential:api-key');
    // A prefix wrapped away from the rest of the key joins again (a short prefix piece is a valid place to continue from).
    expect(flag('OpenAI key for the bench job: sk-\nproj-Fk3vQ9pLm2RtX8wZ4hYc7NbE')).toBe('credential:api-key');
    expect(flag('npm_\nAbCd3fGhIjKlMnOpQrStUvWxYz0123456789')).toBe('credential:npm-token');
  });

  it('still joins a key wrapped over three or four lines (up to three joins in a row)', () => {
    expect(flag('OpenAI key for the bench job: sk-proj-Fk3vQ9\npLm2RtX8w\nZ4hYc7NbE')).toBe('credential:api-key');
    expect(flag('OpenAI key for the bench job: sk-proj-Fk3vQ9\npLm2RtX8\nwZ4hYc7N\nbEq5rT6u')).toBe('credential:api-key');
  });

  it('a password in a JSON text is refused whatever field follows it (a JSON fragment is no exemption after a password cue)', () => {
    expect(flag('{"password":"hunter2","port":5432}')).toBe('credential:credential-in-words');
    expect(flag('{"password":"Violet-maple-6705","user":"admin"}')).toBe('credential:credential-in-words');
    expect(flag('{"tokens":47126,"completion_tokens":980}')).toBeNull();
  });

  it('a short password in a URL is let through only when it is a plain word; with a digit or a symbol it is a credential however short', () => {
    for (const pw of ['x9', '!!', 'a1', 'p#']) expect(flag(`postgres://admin:${pw}@host/db`), pw).toBe('credential:url-with-password');
    for (const pw of ['pass', 'abc', 'changeme', 'user']) expect(flag(`postgres://admin:${pw}@host/db`), pw).toBeNull();
  });

  it('documents the limit: a key split across two saves, or into a piece with no digit or symbol, is not joined', () => {
    expect(flag('OpenAI key for the bench job: sk-proj-Fk3vQ9')).toBeNull(); // the first half alone
    expect(flag('OpenAI key for the bench job: sk-proj-Fk3vQ9\nRtXwZhYcNbEqwerty')).toBeNull(); // no digit in the second piece
  });
});

describe('provider prefixes the measured list did not have', () => {
  const r = new Rng(41);
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const HEX = '0123456789abcdef';
  const cases: Array<[string, string]> = [
    ['credential:npm-token', `npm auth for the bench job: npm_${r.str(36)}`],
    ['credential:huggingface-token', `huggingface sandbox for the bench job: hf_${r.str(34)}`],
    ['credential:aws-access-key', `aws session for the bench job: ASIA${r.str(16, UPPER)}`],
    ['credential:aws-access-key', `aws key for the bench job: AKIA${r.str(16, UPPER)}`],
    ['credential:stripe-key', `stripe sandbox for the bench job: sk_test_${r.str(24)}`],
    ['credential:stripe-key', `stripe restricted sandbox for the bench job: rk_test_${r.str(24)}`],
    ['credential:gitlab-token', `gitlab for the bench job: glpat-${r.str(20)}`],
    ['credential:slack-token', `slack config for the bench job: xoxe-1-${r.str(40)}`],
    ['credential:shopify-token', `shopify app for the bench job: shpat_${r.str(32, HEX)}`],
  ];
  for (const [want, text] of cases) {
    it(`flags ${text.split(':')[1].trim().slice(0, 16)}… with no context word`, () => {
      expect(flag(text)).toBe(want);
    });
  }
});

describe('a provider prefix with an all-hex tail (PR 605 review: the random-tail check read hex as a word)', () => {
  const r = new Rng(606);
  const HEX = '0123456789abcdef';
  const UPPER_HEX = '0123456789ABCDEF';
  it('refuses sk-ant-api03- followed by 32, 64 and 95 hex characters', () => {
    for (const n of [32, 64, 95]) {
      expect(flag(`anthropic key: sk-ant-api03-${r.str(n, HEX)}`), `${n} hex`).toBe('credential:api-key');
    }
  });
  it('refuses the hive-breaker key shape (sk-ant-api03- and 32 hex-like characters) with no context word', () => {
    expect(flag('sk-ant-api03-' + '0123456789abcdef0123456789abcdef')).toBe('credential:api-key');
  });
  it('refuses sk-proj-, ghp_ and AKIA with a hex tail', () => {
    expect(flag(`openai project key: sk-proj-${r.str(64, HEX)}`)).toBe('credential:api-key');
    expect(flag(`github token: ghp_${r.str(36, HEX)}`)).toBe('credential:github-token');
    expect(flag(`aws key: AKIA${r.str(16, UPPER_HEX)}`)).toBe('credential:aws-access-key');
  });
  it('keeps the placeholder tails allowed: one repeated character, x/X/0 runs and a your-key-here stand-in', () => {
    expect(flag('anthropic key: sk-ant-api03-' + 'x'.repeat(32))).toBeNull();
    expect(flag('anthropic key: sk-ant-api03-' + 'X'.repeat(93))).toBeNull();
    expect(flag('anthropic key: sk-ant-api03-' + '0'.repeat(64))).toBeNull();
    expect(flag('openai key: sk-...your-key-here')).toBeNull();
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

  it('catches 221 of the 243 planted secrets and refuses 5 of 130 benign texts', () => {
    // 229 and 12 before 2026-10-13 (data/renor-secret-guard-accuracy/report.md). The 14 email addresses are no longer refused
    // (owner decision, "guard option b"): 14 lost. Gained, net minus 8: the 7 placeholders ("password: ********") are
    // stored, 2 more 32-hex tokens after "key:" or "Bearer" are refused, and the 4 phone numbers the old group size missed.
    expect(verdicts(buildPlantedSet())).toEqual({
      caught: 221, planted: 243, benign: 130,
      missed: { 'key:twilio': 1, 'key:hex64': 1, nl_credential: 6, pii_email: 14 },
      falseBlocks: { 'benign:tracking': 5 },
    });
  });

  it('catches 55 of the 60 robustness secrets and refuses none of the 10 long benign texts', () => {
    // unchanged by the 2026-10-13 scanner: base64 is decoded and screened whatever the words around it say, and a password spoken as
    // "granite dash violet dash zephyr 1586" has its own rule
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
