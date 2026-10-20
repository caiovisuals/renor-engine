/**
 * Tier-0 secret scanner: deterministic, local, no model, no network, no cost.
 *
 * A port of the "rules++" regex-and-entropy scanner measured in the decision-layer investigation
 * (renor-decision-models-scout, 2026-10-03; gitleaks-style, written from public pattern knowledge).
 * Measured there on 443 planted synthetic items: 229 / 243 caught (94.2 %), 9 / 200 benign flagged
 * (4.5 %). Docs: docs/evals/results/SECRET-GUARD-TIER0-20261003.md. The pattern set and the order they
 * run in are the measured scanner's. Five things differ, and nothing else was tuned:
 *
 *   1. A cue word ("pin", "password", ...) must be a whole word. The measured rule matched it inside other
 *      words, so "pin" fired on "shopping", "helping" and "opinions". This can only remove matches (every
 *      match now is a match of the measured rule). Every verdict on the measured sets is unchanged, and the
 *      flags on 82,724 natural chat turns went from 301 to 28 (0.364 % to 0.034 %).
 *   2. The URL rule finds "://" first and checks the scheme behind it, and
 *   3. an email's local part is capped at 64 characters.
 *      Both accept exactly the texts the measured patterns accepted (differential fuzz, in the tests) and
 *      replace a pattern that was quadratic on a long run of "a.a.a." or of word characters.
 *   4. The text is folded before the rules run: NFKC, and the Unicode format characters (zero-width space, word
 *      joiner, soft hyphen, byte-order mark) removed. The provider prefixes that are not in the measured set (npm_,
 *      hf_, ASIA, sk_test_, rk_test_, glpat-, xoxe-, shpat_) are added. A provider key broken by a line break or a
 *      space inside it is joined back for those prefix rules only (joinSplitKeys). The stored text is never changed.
 *   5. The connector after a cue word is a whole word: "is", "are" or Portuguese "é". The measured rule matched "is"
 *      inside "this" and "Island", so a cue word followed by "this note." was refused. This removes those matches and adds
 *      "é"; the planted-set count moved, and the pinned numbers in the tests say how.
 *   6. The rules judge the VALUE, not the cue word (2026-10-13, docs/evals/results/SECRET-GUARD-TIER0-20261003.md and
 *      data/renor-secret-guard-accuracy/report.md). The measured rules fired on "token", "secret", "password", "pin" or "login"
 *      followed by "is", ":" or "=" and any four characters, and on any long token in a text that said "key" anywhere: 15.5 of
 *      every 1,000 lines of the repository docs. Now a cue value must look like a secret (valueLooksSecret: a word with a digit or a
 *      symbol, a PIN, a passphrase after a password cue, a long random token; never a plain word, a name, a path, a placeholder
 *      or a hash), a long token must look random (looksRandom) and have a key word shortly before it, and the open-ended
 *      provider tails must look random. The gap between cue and connector is plain words (up to 80 characters), a seed phrase
 *      and a list of backup codes have their own rules, and a password in a URL is not "password" or a placeholder.
 *      Review round 7 (tests/extraction/secretScannerDifferential.test.ts compares this file with a frozen copy of the parent scanner on 24,000
 *      generated texts): a word that mixes scripts ("раssword") is never a word; a template, placeholder, email or env reference is skipped only
 *      as the WHOLE value, and the tokens after it on the line are judged as values too ("password: ${DB_PASSWORD} then Zq8Lm2Vn7Rt4");
 *      Unicode dashes and spaces are read as the ASCII ones in a card, phone number or id; a value that ends in a comma is judged like any other.
 *   7. Personal identifiers follow the owner's decision of 2026-10-13 ("guard option b"): a card needs a real issuer prefix and
 *      length, a phone number must be written like one (a "+", a bracketed area code or separated groups, never a bare run of
 *      digits), national ids stay, and email addresses are no longer refused.
 *
 * It answers one question: does this text look like it carries a secret? The answer is a class and a
 * rule label taken from the table below, never text from the input, so a caller can say what it found
 * without repeating it.
 *
 *   credential  an API key, token, private key, password-bearing URL, or a password / PIN / recovery
 *               phrase stated in words
 *   identifier  a payment card (Luhn-valid, real issuer), government ID or phone number written like one (not an email address)
 *
 * What it does not catch (measured, so not a surprise): a password said as one plain word ("the wifi password is sunshine" reads
 * like "the password is required"), a password spoken as words ("granite dash violet"), a credential said in words without a cue word
 * ("the door code is ..."), a bare 32-hex token with no cue word, some phone formats, a key split across two
 * lines or spaces where a piece has no digit or symbol (joinSplitKeys), a key split across two saves, a key written
 * in Cyrillic or another lookalike script, a base64 or hex encoding with no context word. What it flags that is
 * not a secret: a placeholder such as "password: ********", and a long number that has a phone-like shape (a
 * tracking number).
 */

export type SecretClass = 'credential' | 'identifier';

export interface SecretFinding {
  /** A label from SECRET_RULES: fixed text, never part of the scanned input. */
  rule: string;
  class: SecretClass;
}

export interface SecretRule {
  id: string;
  class: SecretClass;
  /**
   * Global, so every match can be walked with `matchAll`, which works on a copy. Never `exec` or
   * `test` it (that would leave `lastIndex` behind for the next caller); `String#search` is safe.
   */
  re: RegExp;
  /** The rule only runs on text that also matches this (a gate, not part of the match). */
  needs?: RegExp;
  /** Reject a match with the shape of a secret but not its content (a failed check sum, a date, no scheme). */
  accept?: (match: string, text: string, at: number) => boolean;
  /** Also runs on the copy with a line break or space removed inside a key (joinSplitKeys). Provider prefixes only. */
  split?: boolean;
}

/** Shannon entropy of `s` in bits per character. */
function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  let n = 0;
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    n++;
  }
  let h = 0;
  for (const c of counts.values()) h -= (c / n) * Math.log2(c / n);
  return h;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

const MAX_DECODE = 4096;
const printable = (d: string) => d.length >= 16 && (d.match(/[\x20-\x7e\n\t]/g)?.length ?? 0) / d.length >= 0.9;

/** Is `tok` a base64, hex or percent-escaped form of text that holds a provider key? Decoding is bounded and never throws. */
function decodedHoldsProviderKey(tok: string): boolean {
  const t = tok.slice(0, MAX_DECODE);
  const decoded: string[] = [];
  try {
    if (t.includes('%')) decoded.push(decodeURIComponent(t));
    else {
      decoded.push(Buffer.from(t, 'base64').toString('latin1'));
      if (/^(?:[0-9a-fA-F]{2})+$/.test(t)) decoded.push(Buffer.from(t, 'hex').toString('latin1'));
    }
  } catch { return false; }
  return decoded.some(d => printable(d) && firstMatch(d, SPLIT_RULES) !== null);
}

const DISCOVER_OR_UNIONPAY = /^(?:6011|64[4-9]|65|62)/; // 622126-622925 is Discover's, inside UnionPay's whole 62 prefix

/** A card number has an issuer prefix and a length that issuer uses: Visa 13/16/19, Mastercard 16, Amex 15, Diners 14, Discover and UnionPay 16 to 19, JCB 16. */
function cardIssuer(d: string): boolean {
  return (d.length === 15 && /^3[47]/.test(d))
    || (d.length === 14 && /^3(?:0[0-5]|[689])/.test(d)) // Diners Club
    || (d.length === 16 && /^(?:4|5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720)|35)/.test(d))
    || (d.length >= 16 && d.length <= 19 && /^35(?:2[89]|[3-8]\d)/.test(d)) // JCB 3528-3589, 16 to 19 digits
    || (d.length >= 16 && d.length <= 19 && DISCOVER_OR_UNIONPAY.test(d)) // Discover 6011, 644-649, 65 and 622126-622925 (inside UnionPay 62)
    || ((d.length === 13 || d.length === 19) && d[0] === '4');
}

/**
 * Does a URL scheme end at `at`? That is, is there a lowercase letter, at a word boundary, followed only by
 * lowercase letters, digits, "+", "-" or "." up to `at`? One backward pass over the run, so the cost of a
 * text is its length however long a dotted run is.
 */
function endsWithScheme(text: string, at: number): boolean {
  const inScheme = (c: string) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '+' || c === '.' || c === '-';
  const isWord = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
  let start = at;
  while (start > 0 && inScheme(text[start - 1])) start--;
  for (let p = start; p < at; p++) {
    const c = text[p];
    if (c >= 'a' && c <= 'z' && (p === 0 || !isWord(text[p - 1]))) return true;
  }
  return false;
}


// ----------------------------------------------------------------------------- judging the value, not the word
// 2026-10-13 (data/renor-secret-guard-accuracy/report.md): the measured rules fired on the cue WORD, so "The API key is
// rotated every 90 days" was refused (15.5 lines in 1,000 of the repository docs). The rules below keep the same cue words
// and ask what follows: does the value look like a secret, or like a word, a name, a path, a placeholder, a hash?

// Letters are Unicode letters: a password written in Cyrillic, Greek or Arabic script is judged like a Latin one.
const vowelRatio = (x: string) => (x.match(/[aeiouAEIOU]/g)?.length ?? 0) / x.length;
const wordSeg = (x: string) => /^\p{Ll}+$/u.test(x) || /^\p{Lu}\p{Ll}+$/u.test(x) || /^\p{Lu}+$/u.test(x);

// Scripts with letters that look like Latin ones (Cyrillic "а" for "a", Greek "ο" for "o"). A word that writes letters of two of them, or Latin and one
// of them, is not a word of any language: it is a look-alike spelling meant to get past a letters-only check, or a generated string. Each run of
// letters is judged on its own, so "task-queue-ключ" (a Latin word, a Cyrillic word) is a slug and "раssword" (Cyrillic and Latin in one word) is not.
const LOOKALIKE_SCRIPT = [/\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u, /\p{Script=Cherokee}/u, /\p{Script=Coptic}/u];
function mixesScripts(v: string): boolean {
  return (v.match(/\p{L}[\p{L}\p{M}]*/gu) ?? []).some(run => {
    const others = LOOKALIKE_SCRIPT.filter(re => re.test(run)).length;
    return others >= 2 || (others === 1 && /\p{Script=Latin}/u.test(run));
  });
}

/** Slugs, identifiers, branch names and paths: most of the pieces between "-", "_", ".", "/" or ":" are plain words or numbers. */
function wordish(tok: string): boolean {
  if (/[!@#$%^&*~?{}()<>|\\`"']/.test(tok)) return false; // a bracket, a quote or an operator inside the token: code or a generated string, not a slug
  const segs = tok.split(/[-_./:]+/).filter(Boolean);
  if (segs.length === 0) return true;
  const words = segs.filter(x => (/^\p{L}{3,}$/u.test(x) && wordSeg(x) && (x.length < 12 || vowelRatio(x) >= 0.25)) || /^\p{Nd}+$/u.test(x) || camelWord(x));
  return words.length / segs.length >= 0.6;
}

/** Is every piece of a path or a name short, a number, a hex id, a word or a camelCase word? "docs/ops" and "tenants/9f8b2c1a/files" are; "ruag8rwe3/1" is not. */
function plainSegments(v: string): boolean {
  return v.split(/[-_./:@+]+/).filter(Boolean).every(x => x.length <= 3 || /^\p{Nd}+$/u.test(x) || /^[0-9a-f]+$/i.test(x) || (/^\p{L}+$/u.test(x) && wordSeg(x)) || camelWord(x));
}

/** camelCase or PascalCase made of humps that can be said: "refreshToken", "getUserProfile". A hump with no vowel ("Gpv", "Stx") is not a word. */
function camelWord(x: string): boolean {
  if (x.length < 4 || !/^\p{Ll}*(?:\p{Lu}\p{Ll}+)+$/u.test(x)) return false;
  return (x.match(/\p{Lu}\p{Ll}+/gu) ?? []).every(h => !/^\p{Script=Latin}+$/u.test(h) || /[aeiouy]/i.test(h.normalize('NFD')));
}

const classCount = (s: string) => (/\p{Ll}/u.test(s) ? 1 : 0) + (/\p{Lu}/u.test(s) ? 1 : 0) + (/\p{Nd}/u.test(s) ? 1 : 0);

/** Does a token look machine-generated rather than written? Not words, not a bare hash or uuid, enough entropy for its length, mixed classes. */
function looksRandom(tok: string, minLen: number): boolean {
  if (tok.length < minLen) return false;
  if (wordish(tok)) return false;
  if (/^[0-9a-f]+$/i.test(tok)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok)) return false;
  const need = tok.length >= 32 ? 3.9 : tok.length >= 20 ? 3.4 : 3.2;
  if (entropy(tok) < need) return false;
  const classes = classCount(tok);
  return (classes >= 2 && /\p{Nd}/u.test(tok)) || classes === 3 || (/[+/]/.test(tok) && classes >= 2) || (classes === 2 && tok.length >= 24);
}

const MASK_SRC = String.raw`[*•x#.\-_]{3,}|<[^>]*>|\{\{.*\}\}|%[sd]|\.\.\.|…|redacted|changeme|change-me|example|your(?:[-_ ][a-z]+)+|placeholder`;
const MASK = new RegExp(`^(?:${MASK_SRC})$`, 'i'); // a mask or a stand-in for a value
const PLACEHOLDER = new RegExp(`^(?:${MASK_SRC}|null|none|undefined|true|false)$`, 'i'); // and the literals a JSON or a config file holds instead
const ENV_REF = /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\})$/; // $NAME or ${NAME}: a closing brace is not optional
const IDENT_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(.*\))?$/;
const JSON_LIKE = /,\s*"[\w.-]+"\s*:|^["']?[{[]\s*"/; // "tokens":47126,"completion_tokens":980: a JSON fragment
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const PATH_LIKE = /^(?:[~.]{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+\/?$/;
const LEAD_MARK = /^[*_|~("'`[<{]+/;
const TRAIL_MARK = /[.,;:)"'`\]>}!?*_|~\\]+$/;

// Code shapes that are not passwords. Each is excluded only when the WHOLE value has that shape: a "$", "{", "(", "=", "&" or "\\" INSIDE
// a value is a symbol, and Abc=1234, abc${def, abc$(def)ghi, abc=123&def=456 and C:\\Abc1234 are passwords.
const TEMPLATE_CLOSED = /^(?:\$\{[A-Za-z_][\w:.+?=-]*\}|\{\{\s*[\w.-]+\s*\}\}|\$\([A-Za-z_][\w./-]*\))$/; // ${NAME}, ${NAME:-x}, {{name}}, $(cmd)
// A value ends at a space, so "$(openssl rand -hex 32)" reaches this code as "$(openssl". That is a template only when its closing delimiter
// follows later on the same line; "$(Abc1234" and "${Abc1234" with nothing after them are passwords.
const TEMPLATE_OPEN = [
  { open: /^\$\{[A-Za-z_][\w:.+?=-]*$/, start: '${', close: '}' },
  { open: /^\$\([A-Za-z_][\w./-]*$/, start: '$(', close: ')' },
  { open: /^\{\{\s*[\w.-]*$/, start: '{{', close: '}}' },
];
const TEMPLATE_WORD = /^["']?[\w$.\/:=+@%,-]+["']?$/;

/**
 * Is `inner` (the text between a template's opening and closing delimiter) a command or a name and not a hidden value? Few short words, each
 * made of plain characters (no bracket, nested delimiter or backtick), none of which reads as a secret ("Abc1234", "Zq8Lm2Vn7Rt"). An
 * environment variable name ("DB_PASSWORD") is a name, not a value.
 */
function templateContentIsPlain(inner: string): boolean {
  const words = inner.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 10 || inner.length > 120) return false;
  return words.every(w => {
    if (!TEMPLATE_WORD.test(w)) return false;
    const bare = w.replace(/^["']|["']$/g, '').replace(/^\$+/, '');
    return bare.length === 0 || ENV_NAME.test(bare) || !valueLooksSecret(bare, 'token');
  });
}

/** An open template ("$(openssl", cut at the space) is one when its first closing delimiter ends a plain expression. */
function isOpenTemplate(w: string, rest: string): boolean {
  for (const t of TEMPLATE_OPEN) {
    if (!t.open.test(w)) continue;
    const end = rest.indexOf(t.close);
    if (end < 0) return false;
    return templateContentIsPlain(w.slice(t.start.length) + ' ' + rest.slice(0, end));
  }
  return false;
}
const KNOWN_CALLEE = /^(?:sha\d*|md5|hmac|hash|bcrypt|argon2|uuid|uuid4|getenv|env|environ|get|read|load|fetch|decrypt|encrypt|prompt|input|getpass|secret|secrets|vault|pass|op|random\w*|rand\w*|generate\w*|get[A-Z]\w*|read[A-Z]\w*|load[A-Z]\w*|fetch[A-Z]\w*|hash[A-Z]\w*|from[A-Z]\w*|to[A-Z]\w*)$/;
const CALL_CHAIN = /^[A-Za-z_][\w.]*\([^()]*\)(?:\.[A-Za-z_]\w*(?:\([^()]*\))?)*$/; // sha256(raw_token), randomBytes(24).toString('hex')
/** A call is code when its function names are plain and no argument is a word glued to a number or holds an operator: "Qyjh(636bi)" is a password. */
function isPlainCall(w: string, pwCue = false): boolean {
  if (!CALL_CHAIN.test(w)) return false;
  // After a password cue the parent refused every call ("Gdwo(ibeld)" is a password): a call is code there only when its function is one a config or a
  // script really uses to fetch or derive a secret, never a word-shaped name made of letters.
  if (pwCue && !(w.match(/[A-Za-z_][\w.]*(?=\()/g) ?? []).every(c => KNOWN_CALLEE.test(c.split('.').pop() ?? ''))) return false;
  const calleesPlain = (w.match(/[A-Za-z_][\w.]*(?=\()/g) ?? []).every(c => c.split('.').every(n => { const b = n.replace(/\d+/g, ''); return b.length < 3 || wordish(b); }));
  const args = (w.match(/\(([^()]*)\)/g) ?? []).join(' ');
  return calleesPlain && !/[A-Za-z]\d|\d[A-Za-z]/.test(args.replace(/'[^']*'|"[^"]*"/g, '')) && !/[!@#$%^&*+=~?\\|]/.test(args);
}
const QUERY_PLACEHOLDER = /^(?:|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|<[^>]*>|\{\{[^}]*\}\}|\.\.\.|…)$/;

/** Is the whole value one template placeholder, a call, a query of placeholders, or a path with no secret-shaped segment? */
function isCodeShape(value: string, rest: string, pwCue = false): boolean {
  const w = value.replace(/^["'`]+|["'`,;.]+$/g, '');
  if (TEMPLATE_CLOSED.test(w) || isPlainCall(w, pwCue)) return true;
  if (isOpenTemplate(w, rest)) return true;
  // "?token=${TOKEN}&x=" is a query of placeholders; "Abc123=" (a password with base64 padding) is not, so an empty value counts only after a "?" or "#".
  if (/^[?#]?[\w.-]+=[^&=]*(?:&[\w.-]+=[^&=]*)*$/.test(w)
    && w.replace(/^[?#]/, '').split('&').every(kv => {
      const key = kv.slice(0, kv.indexOf('=')), val = kv.slice(kv.indexOf('=') + 1);
      if (!ENV_NAME.test(key) && !wordish(key.replace(/\d+/g, ''))) return false; // "HCcIBxbf=$F8" is a password; "access_token=$TOKEN" is a query
      return val === '' ? /^[?#]/.test(w) : QUERY_PLACEHOLDER.test(val);
    })) return true;
  if (/^[A-Za-z]:\\/.test(w)) return w.split('\\').slice(1).every(seg => !(seg.length >= 6 && /[A-Za-z]/.test(seg) && /\d/.test(seg)) && !looksRandom(seg, 12));
  return false;
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}$/i;
const EMAIL_OR_HOST = new RegExp(`${EMAIL.source}|\\.(?:com|org|net|io|dev|app|cloud|ai|co)$`, 'i');

/** The value as written and without a wrapper in front of it (a quote, a bracket, a parenthesis, an emphasis mark): "(${X}" and "*{{" are templates inside a wrapper. */
const unwrapped = (raw: string) => [raw, raw.replace(/^[("'`[]+/, ''), raw.replace(/^[("'`*_|~[]+/, '')];

/**
 * Is the value a stand-in for a secret and not a statement about one: a template ("${DB_PASSWORD}", "{{ vault.token }}", "$(vault read db)"), an
 * environment reference, a mask ("********", "<redacted>", "changeme") or an email address? Then the tokens after it may still hold the secret.
 * A call, a hostname, a URL, "null" or a word are not stand-ins: the text after them is prose or code.
 */
function isStandIn(raw: string, rest: string): boolean {
  return unwrapped(raw).some(r => {
    const w = r.replace(/^["'`]+|["'`,;.]+$/g, ''), v = r.replace(LEAD_MARK, '').replace(TRAIL_MARK, '');
    return MASK.test(r.replace(/^["'`]+|["'`,;]+$/g, '')) || MASK.test(w) || MASK.test(v) || ENV_REF.test(w) || TEMPLATE_CLOSED.test(w) || isOpenTemplate(w, rest) || EMAIL.test(v);
  });
}

/**
 * The value after "password is": does it look like a stored secret, or like prose, code, a name, a path, a placeholder?
 * `cue` is the cue word that introduced it: a PIN-like cue accepts a 4 to 10 digit number, a password cue a 6+ digit one.
 */
function valueLooksSecret(raw: string, cue: string, rest = ''): boolean {
  if (PLACEHOLDER.test(raw.replace(/^["'`]+|["'`,;.]+$/g, ''))) return false; // '<owner-secret>' keeps its brackets for this test
  const v = raw.replace(LEAD_MARK, '').replace(TRAIL_MARK, '');
  if (v.length < 4) return false;
  // A code shape as a whole (a template placeholder, a call, a query of placeholders, a path), an address, a host name, a URL: not passwords.
  // A symbol INSIDE a value is not on this list: Abc=1234, abc{def, abc\def, abc$1234, abc${def are passwords.
  // A JSON fragment ("tokens":47126,"completion_tokens":980) is not a token, but after a PASSWORD cue what follows the value in a JSON text is
  // the next field, not a sign the value is no password: {"password":"hunter2","port":5432} is refused as it was.
  const passwordCue = /^(?:password|passwd|pwd|senha|passphrase)s?$/i.test(cue);
  if (isCodeShape(raw, rest, passwordCue) || (!passwordCue && JSON_LIKE.test(raw))) return false;
  if (EMAIL_OR_HOST.test(v)) return false;
  if (PLACEHOLDER.test(v) || ENV_REF.test(raw.replace(/^["'`]+|["'`,;.]+$/g, '')) || /^https?:\/\//i.test(v)) return false; // ENV_REF on the raw value: a stray closing brace is not trimmed away
  if (ENV_NAME.test(v) && !/\d/.test(v)) return false;
  if (mixesScripts(v)) return true; // after the code shapes, placeholders and addresses above: a look-alike or mixed-script value is never a word, a name or a slug
  const pinCue = /^(?:pin|passcode|combination|recovery code|backup code|code)s?$/i.test(cue);
  const pwCue = /^(?:password|passwd|pwd|senha|passphrase)s?$/i.test(cue);
  if (/^\p{Nd}+$/u.test(v)) return (pinCue && v.length >= 4 && v.length <= 10) || (pwCue && v.length >= 6);
  // After a token, secret or key cue a dotted name or a path is code (a dotted property name, docs/ops); after a password cue it is a password.
  if (!pwCue && (IDENT_PATH.test(v) || (PATH_LIKE.test(v) && !/[A-Z].*\d|\d.*[A-Z]/.test(v) && plainSegments(v)))) return false;
  if (/^v?\d+(?:\.\d+)+/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v)) return false;
  const hasLetter = /\p{L}/u.test(v), hasDigit = /\p{Nd}/u.test(v);
  // Every symbol counts after a password cue. After another cue (token, secret, key, login) only the symbols a generated secret holds do:
  // quotes, brackets, parentheses, dots, dashes and colons are code and prose there (measured: counting them takes the repo docs from 0.2 to 0.5
  // false alarms in 1,000 lines).
  const hasSymbol = pwCue ? /[^\p{L}\p{Nd}]/u.test(v) : /[!@#$%^&*+=/~?]/.test(v);
  // A passphrase written as words joined by "-" or "_" ("correct-horse-battery"): after a password cue it is a secret, not a slug.
  if (pwCue && v.length >= 8 && /^\p{L}{3,}(?:[-_]\p{L}{2,})+$/u.test(v)) return true;
  const minMixed = pwCue ? 4 : 6; // a short password is still a password: "password: ab12"
  if (v.length >= minMixed && hasLetter && hasDigit) return true; // "Violet-maple-6705", "hunter2": a word and a number is how people write passwords
  if (!pwCue && wordish(v)) return false;
  if (v.length >= minMixed && hasLetter && hasSymbol) return true;
  if (pwCue && v.length >= 6 && hasDigit && hasSymbol) return true; // "123-456-789", "12#45678": digits and a symbol are a password after a password cue
  if (v.length >= 8 && /\p{Ll}/u.test(v) && /\p{Lu}/u.test(v.slice(1)) && !/^\p{Lu}\p{Ll}+$/u.test(v)) return true;
  return looksRandom(v, 16);
}

/**
 * A value that is not a secret by SHAPE (a template, a placeholder, an email, an env reference) is not the end of what the cue introduced:
 * "password: ${DB_PASSWORD} then Zq8Lm2Vn7Rt4" states a secret after a template. The tokens that follow it on the same line are judged as values too, the first twelve of
 * them, and a template or call that a space cut in two ends at its closing delimiter ("$(vault read db) Zq8Lm2" starts after the ")").
 */
function tailLooksSecret(value: string, rest: string, cue: string): boolean {
  if (!isStandIn(value, rest)) return false; // a plain word ("password is stored in Vault") is a statement; the tokens after it are prose
  let after = rest;
  for (const form of unwrapped(value)) {
    const w = form.replace(/^["'`]+|["'`,;.]+$/g, '');
    const t = TEMPLATE_OPEN.find(o => o.open.test(w));
    if (!t) continue;
    const end = rest.indexOf(t.close);
    after = end < 0 ? '' : rest.slice(end + t.close.length);
    break;
  }
  // The tail is judged as a value after the same cue: after a password cue it can be a short word and number, a symbol or six digits.
  return after.split(/\s+/).filter(Boolean).slice(0, 12).some(tok => {
    const t = tok.replace(/^[:=/,]+/, '');
    const assignment = t.match(/^([A-Za-z_][\w.-]*)=/); // NAME=value carries its own cue word; it is not the value of this one
    if (assignment && ENV_NAME.test(assignment[1])) return false;
    return valueLooksSecret(t, cue);
  });
}

/**
 * The provider rules whose tail is open ended. A token with a provider's key prefix and a tail as long as the shortest that provider issues (the
 * length of each rule's pattern) is refused, with no test of how random the tail looks: a fair random draw of hex or lowercase letters falls below any
 * entropy bar often enough to store a real key, and each round of tuning found another way (PR 605 review rounds 1 to 9). The only exemption is a
 * tail that says it is a stand-in: one repeated character, a run of x, X, *, 0 or dots, or placeholder words ("your-key-here"). The generic "sk-"
 * prefix also lets a slug of three or more plain words through (an "sk-learn-user-guide" style name, the scikit-learn package).
 */
const PLACEHOLDER_WORDS = /^(?:your|key|here|example|redacted|token|dummy|fake|test|placeholder|changeme)+$/i;
function placeholderTail(tail: string): boolean {
  if (/^(.)\1*$/su.test(tail) || /^[xX*0.]+$/.test(tail)) return true;
  const pieces = tail.split(/[-_]/).filter(Boolean);
  return pieces.length > 0 && pieces.every(x => /^(.)\1*$/su.test(x) || /^[xX*0.]+$/.test(x) || PLACEHOLDER_WORDS.test(x));
}
const WORD_SLUG_PIECE = /^\p{Ll}{2,}$|^\p{Nd}+$/u;
const providerTail = (prefixLen: number, slugAllowed = false) => (m: string) => {
  const tail = m.slice(prefixLen).replace(/^(?:proj|ant(?:-api\d+)?|svcacct|admin)-/, ''); // "sk-proj-" and "sk-ant-api03-": the key starts after them
  if (placeholderTail(tail)) return false;
  if (slugAllowed) {
    const pieces = tail.split(/[-_]/);
    if (pieces.length >= 3 && pieces.every(x => WORD_SLUG_PIECE.test(x))) return false;
  }
  return true;
};

/**
 * Words that make a following value a credential ("password is X", "PIN: X"). A whole word, plural allowed:
 * letters and digits may not touch it, but "_" may (WIFI_PASSWORD, admin_pin). The measured rule had no
 * boundary at all, which is where "pin" in "shopping" came from.
 */
const CUE_WORDS = String.raw`(?:password|passwd|pwd|pin|senha|secret|token|api[_\s-]*key|passcode|recovery code|backup code|seed phrase|combination|credential|private key|login|passphrase|secret key|access key)s?`;
const CUE = String.raw`(?<![\p{L}\p{N}])${CUE_WORDS}(?![\p{L}\p{N}])`;
const CUE_AT_START = new RegExp(`^${CUE_WORDS}`, 'iu');
/** The value of a cue match: what follows the connector, up to the first space, comma or semicolon. */
const CUE_VALUE = new RegExp(`^${CUE_WORDS}[\\p{L} \\t_'\u2019-]{0,80}?(?:(?<![\\p{L}\\p{N}])(?:is|are|é)(?![\\p{L}\\p{N}])|["'\`]?\\s*[:=])\\s*((?:[^\\s,;]|[,;])+)$`, 'iu');
const cueValue = (m: string) => m.match(CUE_VALUE)?.[1] ?? '';
/** The value of a connector-less cue match: the token after the cue word. */
/** The rest of the line after position `from`, capped: where a template that a space cut in two closes. */
const restOfLine = (text: string, from: number) => text.slice(from, from + 300).split('\n')[0];
const bareValue = (m: string) => m.match(/[^\s,;]+$/u)?.[0] ?? '';

/**
 * Walked in this order and the first accepted match wins, so a text that holds a credential and an
 * identifier is a credential. `\w` is written as its Unicode class because the measured scanner's was.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  // Provider-shaped keys. OpenAI sk-/sk-proj- and Anthropic sk-ant- are one shape (sk-, then a long run).
  { id: 'api-key', class: 'credential', re: /sk-[A-Za-z0-9_-]{20,}/gu, accept: providerTail(3, true), split: true },
  { id: 'stripe-key', class: 'credential', re: /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/gu, accept: providerTail(8), split: true },
  { id: 'github-token', class: 'credential', re: /gh[pousr]_[A-Za-z0-9_-]{20,}/gu, accept: providerTail(4), split: true },
  { id: 'github-token', class: 'credential', re: /github_pat_[A-Za-z0-9_]{20,}/gu, accept: providerTail(11), split: true },
  { id: 'aws-access-key', class: 'credential', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, split: true },
  { id: 'google-api-key', class: 'credential', re: /AIza[0-9A-Za-z_-]{30,}/gu, split: true },
  { id: 'slack-token', class: 'credential', re: /xox[baprse]-[0-9A-Za-z-]{10,}/gu, split: true },
  { id: 'sendgrid-key', class: 'credential', re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, split: true },
  { id: 'npm-token', class: 'credential', re: /npm_[A-Za-z0-9]{30,}/gu, accept: providerTail(4), split: true },
  { id: 'huggingface-token', class: 'credential', re: /hf_[A-Za-z0-9]{30,}/gu, accept: providerTail(3), split: true },
  { id: 'gitlab-token', class: 'credential', re: /glpat-[A-Za-z0-9_-]{20,}/gu, accept: providerTail(6), split: true },
  { id: 'shopify-token', class: 'credential', re: /shpat_[a-f0-9]{32}/gu, split: true },
  { id: 'jwt', class: 'credential', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, split: true },
  // A credential written as base64, hex or percent-escapes: decoded (bounded) and screened by the provider rules. This is what the key
  // word "key" used to stand in for: no context word is needed, and text that merely looks like base64 (an image, a slug) decodes to
  // nothing readable and is left alone.
  {
    id: 'encoded-credential',
    class: 'credential',
    re: /(?<![A-Za-z0-9+/_=%-])(?:[A-Za-z0-9+/_-]{24,}={0,2}|(?:%[0-9a-fA-F]{2}){12,})(?![A-Za-z0-9+/_=%-])/gu,
    accept: tok => decodedHoldsProviderKey(tok),
  },
  { id: 'private-key', class: 'credential', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu },
  // A URL with a user and password in it (postgres://user:pw@host, redis://:pw@host). The regex starts at the
  // literal "://" and the scheme is checked behind it: written the other way round, every "a" in "a.a.a.a..."
  // is a candidate scheme start that is scanned to the end of the run, which is quadratic. The rest of the URL
  // is a lookahead (group 1), so a "://" whose scheme is refused does not use up the text of the next one.
  {
    id: 'url-with-password',
    class: 'credential',
    re: /:\/\/(?=([^\s:@/]*:[^\s@/]+@[^\s/]+))/gu,
    accept: (_match, text, at) => {
      if (!endsWithScheme(text, at)) return false;
      // "postgres://user:password@host" and "redis://:changeme@host" are examples, not credentials.
      const pw = text.slice(at + 3).match(/^([^\s:@/]*):([^\s@/]+)@/u)?.[2] ?? '';
      // A short password is let through only when it is a plain word (letters only: the owner's option b allows plain words); one with a digit
      // or a symbol in it ("x9", "!!") is an explicit credential however short.
      return !(pw.length < 4 && /^[A-Za-z]+$/.test(pw)) && !PLACEHOLDER.test(pw) && !ENV_REF.test(pw) && !/^(?:pass|password|pwd|secret|user|username|changeme|xxx+)$/i.test(pw);
    },
  },
  // A cue word, then up to 80 characters of plain words, then "is", "are", ":" or "=", then a value that LOOKS like a secret
  // (valueLooksSecret): not a word, a name, a path, a placeholder or a number. The connector words are whole words:
  // "this" is not "is", so a cue word followed by "this note." is prose. The gap is plain words only, so a table row or a
  // command line does not tie "tokens" to a number thirty characters on.
  {
    id: 'credential-in-words',
    class: 'credential',
    re: new RegExp(`${CUE}[\\p{L} \\t_'\u2019-]{0,80}?(?:(?<![\\p{L}\\p{N}])(?:is|are|é)(?![\\p{L}\\p{N}])|["'\`]?\\s*[:=])\\s*(?:[^\\s,;]|[,;](?=\\S))+`, 'giu'),
    accept: (m, text, at) => {
      const value = cueValue(m), cue = m.match(CUE_AT_START)?.[0] ?? '', rest = restOfLine(text, at + m.length);
      return valueLooksSecret(value, cue, rest) || tailLooksSecret(value, rest, cue);
    },
  },
  // A password spoken with its separators ("granite dash violet dash zephyr 1586"): nothing else in prose reads like this.
  {
    id: 'credential-in-words',
    class: 'credential',
    re: new RegExp(`(?<![\\p{L}\\p{N}])(?:password|passwd|pwd|senha|passphrase|passcode)s?[\\p{L} \\t_'\u2019-]{0,80}?(?:(?<![\\p{L}\\p{N}])(?:is|are|é)(?![\\p{L}\\p{N}])|["'\`]?\\s*[:=])\\s*(?:\\p{L}{3,12}\\s+(?:dash|hyphen|minus|underscore)\\s+){1,}\\p{L}{3,12}(?:\\s+\\d{1,6})?`, 'giu'),
  },
  // No connector: "with password Falcon-meadow-9232". Only for the password-like cues, and only for a value that is
  // unmistakably a secret: 8+ characters of letters and digits or symbols.
  {
    id: 'credential-in-words',
    class: 'credential',
    re: new RegExp(`${CUE}\\s+[^\\s,;]+`, 'giu'),
    accept: m => {
      const cue = m.match(CUE_AT_START)?.[0] ?? '';
      if (!/^(?:password|passwd|pwd|senha|passcode|pin|passphrase)s?$/i.test(cue)) return false;
      const v = bareValue(m).replace(LEAD_MARK, '').replace(TRAIL_MARK, '');
      if (!valueLooksSecret(v, cue)) return false;
      if (/^(?:pin|passcode)s?$/i.test(cue) && /^\d{4,8}$/.test(v)) return true;
      return /^[\p{L}\p{Nd}!@#$%^&*_+-]+$/u.test(v) && v.length >= 8 && /\p{L}/u.test(v) && (/\p{Nd}/u.test(v) || /[!@#$%^&*]/.test(v));
    },
  },
  // A seed phrase (12 to 24 words) or a list of backup codes after its cue: the value is the whole list, not its first word.
  { id: 'seed-phrase', class: 'credential', re: /(?<![\p{L}\p{N}])(?:seed phrase|recovery phrase|mnemonic)[^\n:=]{0,20}[:=]?\s*(?:[a-z]{3,9}[ \t]+){11,23}[a-z]{3,9}/giu },
  { id: 'backup-codes', class: 'credential', re: /(?<![\p{L}\p{N}])(?:backup|recovery) codes?[^\n:=]{0,20}[:=]\s*(?:[A-Za-z0-9-]{6,12}[ ,]+){1,}[A-Za-z0-9-]{6,12}/giu },
  // A long unbroken token that looks random, with a key, token, secret, bearer or password word shortly before it on the same line.
  // A hex run counts only right after such a word (and not after sha, hash, commit, id), because a bare hex run is usually a hash.
  {
    id: 'high-entropy-token',
    class: 'credential',
    re: /(?<![A-Za-z0-9/+_.-])[A-Za-z0-9/+_=-]{32,}(?![A-Za-z0-9/+_-])/gu,
    accept: (tok, text, at) => {
      // The line start within a bounded window before the token: a text with no newline must not be searched back to its start for every
      // candidate (quadratic on a long single line). Nothing here looks further back than 48 characters but the URL check below.
      const floor = Math.max(0, at - 2048);
      const lineStart = floor + text.slice(floor, at).lastIndexOf('\n') + 1;
      const before = text.slice(Math.max(lineStart, at - 48), at);
      const near = text.slice(Math.max(lineStart, at - 16), at);
      if (/^[0-9a-f]{32,128}$/i.test(tok)) {
        if (tok.length === 40) return false; // a SHA-1 or a git commit
        return entropy(tok) >= 3 && /(?:key|token|secret|bearer|authorization|password)[\s:="'`]*$/i.test(near) && !/(?:commit|sha|hash|digest|checksum|id)[\s:="'`]*$/i.test(near);
      }
      if (!/(?:key|token|secret|credential|bearer|authorization|api|password|passwd)/i.test(before)) return false;
      if (!looksRandom(tok, 32)) return false;
      return !/https?:\/\/\S*$/.test(text.slice(lineStart, at));
    },
  },
  // Owner decision 2026-10-13 ("guard option b"): refuse credentials, cards, national ids and phone numbers written like
  // phone numbers; allow email addresses. A card needs a real issuer prefix and length as well as the check sum, and may not
  // touch a letter, ".", "/" or "-" ("20260923180000" in a migration name passes the check sum one time in ten).
  {
    id: 'payment-card',
    class: 'identifier',
    re: /(?<![\p{L}\p{N}_./-])(?:\d[ -]?){13,19}(?![\p{L}\p{N}_/-])/gu,
    accept: m => {
      const d = digitsOf(m);
      return luhn(d) && cardIssuer(d);
    },
  },
  { id: 'national-id', class: 'identifier', re: /\b\d{3}-\d{2}-\d{4}\b/gu },
  { id: 'national-id', class: 'identifier', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/gu },
  { id: 'national-id', class: 'identifier', re: /passport[^\n]{0,25}?\b[A-Z]\d{6,8}\b/giu },
  { id: 'national-id', class: 'identifier', re: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gu },
  // A phone number must be written like one: a leading "+", a bracketed area code, or digit groups with separators between them.
  // A bare run of digits (a Unix timestamp, an order number, an id in a URL) is not a phone number.
  {
    id: 'phone',
    class: 'identifier',
    re: /(?<![\p{L}\p{N}_./=-])(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]\d{2,6}){2,4}|\(\d{2,4}\)[\s.-]?\d{3,5}[\s.-]\d{4}|\d{2,4}[\s.-]\d{3,5}[\s.-]\d{4})(?![\p{L}\p{N}_/-])/gu,
    accept: m => {
      const n = digitsOf(m).length;
      return n >= 9 && n <= 14 && !/^\d{4}-\d{2}-\d{2}/.test(m);
    },
  },
];

/** A character a key is written with: the classes the provider rules match, and the dot a JWT is written with. */
const KEY_CHAR = /[A-Za-z0-9_.\-/+=]/;
/** A key fragment that has a digit or a symbol in it. Prose rarely puts two such words side by side. */
const KEY_MARK = /[0-9_\-/+=]/;

/** The key characters at the end of `s`, and at the start of `s`: linear, one pass each. */
function trailingKeyRun(s: string): string {
  let i = s.length;
  while (i > 0 && KEY_CHAR.test(s[i - 1])) i--;
  return s.slice(i);
}

function leadingKeyRun(s: string): string {
  let i = 0;
  while (i < s.length && KEY_CHAR.test(s[i])) i++;
  return s.slice(0, i);
}

/**
 * The text with the whitespace removed between two key fragments that each hold a digit or a symbol, so a key broken
 * by a line break or a space ("sk-proj-Fk3vQ9\npLm2...") reads as one token. Whitespace next to prose is kept:
 * "sk-learn tutorial" and "2026 deployment" do not join, because the second piece of each has no digit or symbol.
 * It runs once per text and tracks whether the current key run has a mark, so the cost is linear in the text.
 */
function joinSplitKeys(text: string): string {
  const parts = text.split(/(\s+)/u);
  let out = parts[0];
  let mark = isKeyTail(trailingKeyRun(parts[0]));
  // A key broken by line wrapping or a space has a few pieces, not a run of words: past MAX_JOINS joins in a row the next piece is
  // left apart, so "sk-learn v2_0 v3_0 v4_0 v5_0" (a version list) does not become one key-shaped token.
  let joins = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const next = parts[i + 1];
    const join = mark && joins < MAX_JOINS && isKeyPiece(leadingKeyRun(next));
    out += join ? next : parts[i] + next;
    joins = join ? joins + 1 : 0;
    const tail = trailingKeyRun(next);
    mark = (join && tail.length === next.length && mark) || isKeyTail(tail);
  }
  return out;
}

/**
 * A piece a key can be wrapped at: a digit or a symbol in it, and a run of three letters or digits (a version word like "v2_0" or a
 * lone "=" is not one), so a stray "=" or a version list neither joins nor uses up the joins of the key that follows it.
 */
function isKeyPiece(run: string): boolean {
  return KEY_MARK.test(run) && /[A-Za-z0-9]{3}/.test(run);
}

/** The end of a piece a key can continue from: a digit or a symbol in it and at least one letter or digit, so a short prefix ("sk-", "hf_") qualifies and a lone "=" does not. */
function isKeyTail(run: string): boolean {
  return KEY_MARK.test(run) && /[A-Za-z0-9]/.test(run);
}

/** Most pieces after the first that a split key is joined from: a wrapped key has two or three, a list of words has many. */
const MAX_JOINS = 3;

/**
 * The text as the rules read it: NFKC, with the Unicode format characters removed (a zero-width space, a word joiner,
 * a soft hyphen or a byte-order mark inside a key is not a break in it). The stored text is never changed; this view is
 * only what is screened.
 *
 * NFKC expands a few punctuation marks into several characters: "…" becomes "...", and "SECRET=…" would then read as a
 * value. Those marks are replaced first by U+E000, which no rule class matches, so they read as the one character they are.
 */
function foldForScan(text: string): string {
  return text
    .replace(/(?![\x00-\x7F])\p{P}/gu, ch => (ch.normalize('NFKC').length > 1 ? '\uE000' : ch))
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '');
}

const SPLIT_RULES = SECRET_RULES.filter(rule => rule.split);
const IDENTIFIER_RULES = SECRET_RULES.filter(rule => rule.class === 'identifier');

/** Every Unicode dash (\p{Pd}), the minus sign (U+2212) and every space separator (\p{Zs}) as the ASCII hyphen and space. */
const foldSeparators = (text: string) => text.replace(/[\p{Pd}\u2212]/gu, '-').replace(/\p{Zs}/gu, ' ');


function firstMatch(text: string, rules: readonly SecretRule[]): SecretFinding | null {
  for (const rule of rules) {
    if (rule.needs && text.search(rule.needs) < 0) continue;
    for (const m of text.matchAll(rule.re)) {
      if (!rule.accept || rule.accept(m[0], text, m.index)) return { rule: rule.id, class: rule.class };
    }
  }
  return null;
}

/**
 * The first thing in `text` that looks like a secret, or null. Deterministic: the same text gives the same answer.
 * Every rule runs on the folded text. Then the provider rules (`split`) run on the copy with a key's line break or space
 * removed, so a key broken across two lines is caught; a text that has no such break is not scanned twice.
 */
export function scanSecrets(text: string): SecretFinding | null {
  const folded = foldForScan(text);
  const direct = firstMatch(folded, SECRET_RULES);
  if (direct !== null) return direct;
  // Folding removes the invisible characters, which can also remove the word boundary a rule needs ("value\u200Bsk-proj-..." reads as
  // "valuesk-proj-..."): what the rules found in the text as written is found still.
  if (folded !== text) {
    const written = firstMatch(text, SECRET_RULES);
    if (written !== null) return written;
  }
  // A card, a phone number or an id written with a typographic dash (en, em, minus, non-breaking hyphen) or a Unicode space between its groups
  // is the same number: NFKC does not fold those, so the identifier rules also read a copy where each separator is the ASCII one.
  const ascii = foldSeparators(folded);
  if (ascii !== folded) {
    const found = firstMatch(ascii, IDENTIFIER_RULES);
    if (found !== null) return found;
  }
  const joined = joinSplitKeys(folded);
  return joined === folded ? null : firstMatch(joined, SPLIT_RULES);
}
