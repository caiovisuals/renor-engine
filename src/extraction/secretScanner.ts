/**
 * Tier-0 secret scanner: deterministic, local, no model, no network, no cost.
 *
 * A port of the "rules++" regex-and-entropy scanner measured in the decision-layer investigation
 * (renor-decision-models-scout, 2026-10-03; gitleaks-style, written from public pattern knowledge).
 * Measured there on 443 planted synthetic items: 229 / 243 caught (94.2 %), 9 / 200 benign flagged
 * (4.5 %). Docs: docs/evals/results/SECRET-GUARD-TIER0-20261003.md. The pattern set and the order they
 * run in are the measured scanner's. Three things differ, and nothing else was tuned:
 *
 *   1. A cue word ("pin", "password", ...) must be a whole word. The measured rule matched it inside other
 *      words, so "pin" fired on "shopping", "helping" and "opinions". This can only remove matches (every
 *      match now is a match of the measured rule). Every verdict on the measured sets is unchanged, and the
 *      flags on 82,724 natural chat turns went from 301 to 28 (0.364 % to 0.034 %).
 *   2. The URL rule finds "://" first and checks the scheme behind it, and
 *   3. an email's local part is capped at 64 characters.
 *      Both accept exactly the texts the measured patterns accepted (differential fuzz, in the tests) and
 *      replace a pattern that was quadratic on a long run of "a.a.a." or of word characters.
 *
 * It answers one question: does this text look like it carries a secret? The answer is a class and a
 * rule label taken from the table below, never text from the input, so a caller can say what it found
 * without repeating it.
 *
 *   credential  an API key, token, private key, password-bearing URL, or a password / PIN / recovery
 *               phrase stated in words
 *   identifier  a payment card (Luhn-valid), email address, government ID or phone number
 *
 * What it does not catch (measured, so not a surprise): a credential said in words without a cue word
 * ("the door code is ..."), a bare 32-hex token with no cue word, some phone formats, a key with its
 * characters spaced apart. What it flags that is not a secret: a placeholder such as
 * "password: ********", and a long number that has a phone-like shape (a tracking number).
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

/**
 * Words that make a following value a credential ("password is X", "PIN: X"). A whole word, plural allowed:
 * letters and digits may not touch it, but "_" may (WIFI_PASSWORD, admin_pin). The measured rule had no
 * boundary at all, which is where "pin" in "shopping" came from.
 */
const CUE = String.raw`(?<![\p{L}\p{N}])(?:password|passwd|pwd|pin|senha|secret|token|api[_ -]?key|passcode|recovery code|backup code|seed phrase|combination|credential|private key|login)s?(?![\p{L}\p{N}])`;

/**
 * Walked in this order and the first accepted match wins, so a text that holds a credential and an
 * identifier is a credential. `\w` is written as its Unicode class because the measured scanner's was.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  // Provider-shaped keys. OpenAI sk-/sk-proj- and Anthropic sk-ant- are one shape (sk-, then a long run).
  { id: 'api-key', class: 'credential', re: /\bsk-[A-Za-z0-9_-]{20,}/gu },
  { id: 'stripe-key', class: 'credential', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/gu },
  { id: 'github-token', class: 'credential', re: /\bgh[pousr]_[A-Za-z0-9_-]{20,}/gu },
  { id: 'github-token', class: 'credential', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/gu },
  { id: 'aws-access-key', class: 'credential', re: /\bAKIA[0-9A-Z]{16}\b/gu },
  { id: 'google-api-key', class: 'credential', re: /\bAIza[0-9A-Za-z_-]{30,}/gu },
  { id: 'slack-token', class: 'credential', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/gu },
  { id: 'sendgrid-key', class: 'credential', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu },
  { id: 'jwt', class: 'credential', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu },
  { id: 'private-key', class: 'credential', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu },
  // A URL with a user and password in it (postgres://user:pw@host, redis://:pw@host). The regex starts at the
  // literal "://" and the scheme is checked behind it: written the other way round, every "a" in "a.a.a.a..."
  // is a candidate scheme start that is scanned to the end of the run, which is quadratic. The rest of the URL
  // is a lookahead (group 1), so a "://" whose scheme is refused does not use up the text of the next one.
  {
    id: 'url-with-password',
    class: 'credential',
    re: /:\/\/(?=([^\s:@/]*:[^\s@/]+@[^\s/]+))/gu,
    accept: (_match, text, at) => endsWithScheme(text, at),
  },
  // A cue word, then within 25 characters "is", "are", ":" or "=", then a value of 4 or more characters.
  { id: 'credential-in-words', class: 'credential', re: new RegExp(`${CUE}[^\\n]{0,25}?(?:is|are|:|=)\\s*[^\\s,;]{4,}`, 'giu') },
  // A long unbroken token that is not a bare hash, in text that mentions a key, token, secret, etc.
  {
    id: 'high-entropy-token',
    class: 'credential',
    re: /(?<![A-Za-z0-9/+_-])[A-Za-z0-9/+_-]{32,}(?![A-Za-z0-9/+_-])/gu,
    needs: /(?:key|token|secret|credential|bearer|authorization|api)/iu,
    accept: tok => entropy(tok) >= 3.6 && !/^[a-f0-9]{40}$/.test(tok),
  },
  { id: 'payment-card', class: 'identifier', re: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu, accept: m => luhn(digitsOf(m)) },
  // The local part is capped at 64 characters: a match needs one character before the "@" and no more,
  // and an unbounded run would make a long word-only text quadratic to scan.
  { id: 'email', class: 'identifier', re: /[\p{L}\p{N}_.+-]{1,64}@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu },
  { id: 'national-id', class: 'identifier', re: /\b\d{3}-\d{2}-\d{4}\b/gu },
  { id: 'national-id', class: 'identifier', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/gu },
  { id: 'national-id', class: 'identifier', re: /passport[^\n]{0,25}?\b[A-Z]\d{6,8}\b/giu },
  { id: 'national-id', class: 'identifier', re: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gu },
  {
    id: 'phone',
    class: 'identifier',
    re: /(?<![\p{L}\p{N}_.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,5}[\s.-]?\d{4}(?![\p{L}\p{N}_])/gu,
    accept: m => {
      const n = digitsOf(m).length;
      return n >= 9 && n <= 13 && !/^\d{4}-\d{2}-\d{2}$/.test(m);
    },
  },
];

/** The first thing in `text` that looks like a secret, or null. Deterministic: the same text gives the same answer. */
export function scanSecrets(text: string): SecretFinding | null {
  for (const rule of SECRET_RULES) {
    if (rule.needs && text.search(rule.needs) < 0) continue;
    for (const m of text.matchAll(rule.re)) {
      if (!rule.accept || rule.accept(m[0], text, m.index)) return { rule: rule.id, class: rule.class };
    }
  }
  return null;
}
