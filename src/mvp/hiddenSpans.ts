/**
 * The spans of a note's text that a rendered Markdown view does not show a reader, labelled in the text an agent
 * reads. A note is untrusted text: what the viewer hides (an HTML comment, a link title, a reference definition, image
 * alt text, a footnote, a collapsed <details> body, the info string of a code fence, text after a long run of spaces
 * or blank lines) reaches an agent verbatim, and nothing in the reply said it was hidden. The label keeps the text and
 * says where it was hidden, so the agent can tell what a reader of the note would not have seen.
 *
 * Only the agent-facing copy is changed: the stored note and export_memory keep every character. Text inside a fenced
 * code block or an inline code span is code, not hidden, and is left alone. A text with no hidden span comes back as
 * the same string, so a reply about such a note is the same reply it was before.
 *
 * The engine has no Markdown syntax tree, so this is a scanner for the constructs above. It reads the text in one
 * pass, as a renderer would: a backslash escape, a code span or fence is opaque, and each other construct is matched
 * where it starts. Its lookups are precomputed once per text (bracket pairs, next-character positions, backtick runs,
 * paragraph breaks), so the work is linear in the length of the text, and no construct is matched by a scan that can
 * run to the end of the text once per start. A collapsed <details> body or a link text that holds more labelled
 * constructs is scanned inside its own label, to MAX_NESTING levels; deeper, its text is kept as it is inside the label.
 *
 * Known gaps: a hidden span that the chunker cut across two chunks (a section over 400 tokens split at a blank line)
 * is labelled only where it opens; indented code blocks are not recognised as code; brackets inside a code span may pair
 * with brackets outside it.
 */

/** A run of this many spaces, after text on the same line and before text on that line, hides what follows it. */
export const LONG_SPACE_RUN = 40;
/** A run of this many blank lines, between text, hides what follows it. */
export const LONG_BLANK_RUN = 10;
/** How deep a labelled body or link text is scanned inside its own label. Past it the text is kept as it is. */
export const MAX_NESTING = 32;

const PUNCTUATION = /[!-\/:-@\[-`{-~]/;
const FENCE_OPEN = /( {0,3})(`{3,}|~{3,})([^\n]*)/y;
const FOOTNOTE_CONTINUE = /\n(?:[ \t\r]*\n)*(?: {4}|\t)[^\n]*/y;
const SUMMARY = /^\s*<summary\b[^>]*>[\s\S]*?<\/summary\s*>/i;
const DETAILS_TAG = /<(\/?)details\b/gi;
const OPEN_ATTRIBUTE = /(?:^|\s)open(?=[\s=/]|$)/i;

interface Step {
  /** Where the scan goes on, in the text it read. */
  end: number;
  /** What the step writes to the agent-facing copy. */
  out: string;
  /** Whether that differs from the text it read. */
  labelled: boolean;
}

function verbatim(text: string, from: number, to: number): Step {
  return { end: to, out: text.slice(from, to), labelled: false };
}

function label(kind: string, body: string): string {
  const inner = body.trim();
  return inner ? `[${kind}: ${inner}]` : `[${kind}]`;
}

function isBlank(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\r';
}

/**
 * The agent-facing copy of `text`: each hidden span labelled in place, the rest unchanged. Returns `text` itself when
 * nothing in it is hidden.
 */
export function labelHiddenSpans(text: string): string {
  return new Labeller(text, 0).run();
}

/** A memory's text labelled; the memory itself when nothing in its text is hidden. */
export function labelMemoryText<T extends { text: string }>(memory: T): T {
  if (typeof memory?.text !== 'string') return memory;
  const text = labelHiddenSpans(memory.text);
  return text === memory.text ? memory : { ...memory, text };
}

function labelIn(text: string, depth: number): string {
  return new Labeller(text, depth).run();
}

class Labeller {
  private readonly n: number;
  private readonly tables = new Map<string, Int32Array>();
  private escaped?: Uint8Array;
  private closers?: Int32Array;
  private breaks?: Int32Array;
  private ticks?: Map<number, number[]>;
  private fences?: number[];

  constructor(private readonly text: string, private readonly depth: number) {
    this.n = text.length;
  }

  run(): string {
    const text = this.text;
    let out = '';
    let changed = false;
    let i = 0;
    while (i < this.n) {
      if (i === 0 || text[i - 1] === '\n') {
        const block = this.lineStart(i);
        if (block) {
          out += block.out;
          changed ||= block.labelled;
          i = block.end;
          continue;
        }
      }
      const step = this.inline(i);
      out += step.out;
      changed ||= step.labelled;
      i = step.end;
    }
    return changed ? out : text;
  }

  /** What starts at `at` on a line that is not the start of a block. Anything that opens no hidden span is copied. */
  private inline(at: number): Step {
    const t = this.text;
    const c = t[at];
    if (c === '\\') {
      const next = t[at + 1];
      return verbatim(t, at, next !== undefined && PUNCTUATION.test(next) ? at + 2 : at + 1);
    }
    if (c === '\n') return this.newlines(at);
    if (c === ' ') return this.spaces(at);
    if (c === '`') return this.codeSpan(at);
    if (c === '<') {
      if (t.startsWith('<!--', at)) return this.comment(at);
      if (this.isDetailsOpen(at)) return this.details(at);
      return verbatim(t, at, at + 1);
    }
    if (c === '[') return this.link(at, at, false);
    if (c === '!' && t[at + 1] === '[') return this.link(at, at + 1, true);
    return verbatim(t, at, at + 1);
  }

  /** A run of blank lines that hides the text after it: labelled with a marker, the text is kept. Scanned once. */
  private newlines(at: number): Step {
    const t = this.text;
    let end = at + 1;
    let blank = 0;
    for (;;) {
      let k = end;
      while (k < this.n && isBlank(t[k])) k++;
      if (k < this.n && t[k] === '\n') {
        blank++;
        end = k + 1;
      } else break;
    }
    if (blank >= LONG_BLANK_RUN) {
      let k = end;
      while (k < this.n && isBlank(t[k])) k++;
      if (k < this.n) return { end, out: '\n[hidden: long run of blank lines]\n', labelled: true };
    }
    return verbatim(t, at, end);
  }

  /** A run of spaces after text on one line, before text on that line: a marker when it is long, the text is kept. */
  private spaces(at: number): Step {
    const t = this.text;
    if (at > 0 && (t[at - 1] === ' ' || t[at - 1] === '\t' || t[at - 1] === '\n')) return verbatim(t, at, at + 1);
    let end = at;
    while (end < this.n && t[end] === ' ') end++;
    const next = t[end];
    if (end - at >= LONG_SPACE_RUN && next !== undefined && !/\s/.test(next)) {
      return { end, out: ' [hidden: long run of spaces] ', labelled: true };
    }
    return verbatim(t, at, end);
  }

  /** An inline code span is code: copied as it is. Unclosed backticks are plain text. */
  private codeSpan(at: number): Step {
    const t = this.text;
    let end = at;
    while (end < this.n && t[end] === '`') end++;
    const length = end - at;
    const starts = this.tickRuns().get(length) ?? [];
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < end) lo = mid + 1;
      else hi = mid;
    }
    const start = starts[lo];
    if (start !== undefined && this.breakFrom(end) >= start) return verbatim(t, at, start + length);
    return verbatim(t, at, end);
  }

  private comment(at: number): Step {
    const close = this.text.indexOf('-->', at + 4);
    const end = close < 0 ? this.n : close + 3;
    const inner = this.text.slice(at + 4, close < 0 ? this.n : close).trim();
    const out = inner ? `[hidden HTML comment: ${inner}]` : '[hidden HTML comment]';
    return { end, out, labelled: true };
  }

  private isDetailsOpen(at: number): boolean {
    const t = this.text;
    return t.slice(at, at + 8).toLowerCase() === '<details' && !/\w/.test(t[at + 8] ?? '');
  }

  /**
   * A <details> block that is collapsed: the summary is shown, the body is not, so the body is labelled and its own
   * hidden spans inside it are labelled the same way. A block marked open shows its body and is copied as it is.
   */
  private details(at: number): Step {
    const t = this.text;
    const gt = this.nextOf('>', c => c === '>', at);
    if (gt >= this.n) return verbatim(t, at, at + 1);
    const tagEnd = gt + 1;
    if (OPEN_ATTRIBUTE.test(t.slice(at + 8, gt))) return verbatim(t, at, tagEnd);
    const close = this.detailsClose(tagEnd);
    const bodyEnd = close ? close.at : this.n;
    const body = t.slice(tagEnd, bodyEnd);
    const head = SUMMARY.exec(body)?.[0] ?? '';
    const core = body.slice(head.length).trim();
    if (!core) return verbatim(t, at, tagEnd);
    const inner = this.depth < MAX_NESTING ? labelIn(core, this.depth + 1) : core;
    const closing = close ? t.slice(close.at, close.end) : '';
    const out = `${t.slice(at, tagEnd)}${head}${head ? ' ' : ''}[collapsed details: ${inner}]${closing}`;
    return { end: close ? close.end : this.n, out, labelled: true };
  }

  /**
   * The </details> that closes a block whose body starts at `from`: the one that brings the nesting back to zero, so a
   * nested block closes with its own end. A </details> inside a fenced code block is code and does not count.
   */
  private detailsClose(from: number): { at: number; end: number } | null {
    const re = new RegExp(DETAILS_TAG.source, 'gi');
    re.lastIndex = from;
    let depth = 1;
    for (let m = re.exec(this.text); m !== null; m = re.exec(this.text)) {
      if (this.inFence(m.index)) continue;
      if (m[1] === '/') {
        const gt = this.nextOf('>', c => c === '>', m.index);
        if (gt >= this.n) continue;
        depth--;
        if (depth === 0) return { at: m.index, end: gt + 1 };
      } else {
        depth++;
      }
    }
    return null;
  }

  /** A link (or, with `start` before `lb`, an image) whose text is labelled: its alt text, or its title. */
  private link(start: number, lb: number, image: boolean): Step {
    const t = this.text;
    const close = this.closeOf(lb);
    if (close < 0 || t[close + 1] !== '(') return verbatim(t, start, start + 1);
    const tail = this.linkTail(close + 2);
    if (!tail) return verbatim(t, start, start + 1);
    const words = t.slice(lb + 1, close);
    if (image) {
      const alt = words.trim();
      if (!alt && tail.title === undefined) return verbatim(t, start, start + 1);
      const head = alt ? `[image alt text: ${alt}]` : '![]';
      const title = tail.title === undefined ? '' : ` ${label('link title', tail.title)}`;
      return { end: tail.end, out: `${head}(${tail.dest})${title}`, labelled: true };
    }
    if (tail.title === undefined) return verbatim(t, start, start + 1);
    const inner = this.depth < MAX_NESTING ? labelIn(words, this.depth + 1) : words;
    return { end: tail.end, out: `[${inner}](${tail.dest}) ${label('link title', tail.title)}`, labelled: true };
  }

  /** The destination and title of an inline link whose '(' is before `p`, and the position after its ')'. */
  private linkTail(p: number): { dest: string; title?: string; end: number } | null {
    const t = this.text;
    const k = this.skipWhitespace(p);
    const d = this.destination(k);
    if (!d) return null;
    let kk = this.skipWhitespace(d.end);
    let title: string | undefined;
    if (kk > d.end && this.isTitleOpener(kk)) {
      const r = this.title(kk);
      if (!r) return null;
      title = t.slice(r.start, r.close);
      kk = this.skipWhitespace(r.end);
    }
    if (t[kk] !== ')') return null;
    return { dest: t.slice(k, d.end), title, end: kk + 1 };
  }

  /** A destination: a <...> form on one line, or a run up to whitespace or ')'. */
  private destination(k: number): { end: number } | null {
    const t = this.text;
    if (t[k] === '<') {
      const gt = this.nextOf('>', c => c === '>', k + 1);
      if (gt >= this.n) return null;
      if (this.nextOf('\n', c => c === '\n', k) < gt) return null;
      return { end: gt + 1 };
    }
    return { end: this.nextOf('dest', c => /[\s)]/.test(c), k) };
  }

  /** A title in quotes or parentheses, which may run across lines: the text between its marks. */
  private title(k: number): { start: number; close: number; end: number } | null {
    const open = this.text[k];
    if (!this.isTitleOpener(k)) return null;
    const closer = open === '(' ? ')' : open;
    let c = this.nextOf(closer, x => x === closer, k + 1);
    while (c < this.n && this.isEscaped(c)) c = this.nextOf(closer, x => x === closer, c + 1);
    if (c >= this.n) return null;
    return { start: k + 1, close: c, end: c + 1 };
  }

  private isTitleOpener(k: number): boolean {
    const c = this.text[k];
    return c === '"' || c === "'" || c === '(';
  }

  /**
   * A reference definition at the start of a line: `[label]: destination` with an optional title on the same or the next
   * line. The whole definition is labelled, since a renderer shows none of it.
   */
  private definition(p: number): Step | null {
    const t = this.text;
    const close = this.closeOf(p);
    if (close < 0 || t[close + 1] !== ':') return null;
    let k = close + 2;
    while (k < this.n && isBlank(t[k])) k++;
    if (t[k] === '\n') {
      k++;
      while (k < this.n && isBlank(t[k])) k++;
    }
    const dest = this.destination(k);
    if (!dest || dest.end === k) return null;
    let blockEnd = -1;
    const next = this.skipWhitespace(dest.end);
    if (next > dest.end && this.isTitleOpener(next)) {
      const r = this.title(next);
      if (r) {
        let e = r.end;
        while (e < this.n && isBlank(t[e])) e++;
        if (e >= this.n || t[e] === '\n') blockEnd = e;
      }
    }
    if (blockEnd < 0) {
      let e = dest.end;
      while (e < this.n && isBlank(t[e])) e++;
      if (e < this.n && t[e] !== '\n') return null;
      blockEnd = e;
    }
    const raw = t.slice(p, blockEnd).trim();
    return { end: blockEnd, out: `[reference definition: ${raw}]`, labelled: true };
  }

  /** A footnote definition at the start of a line: its text and the lines indented under it, labelled. */
  private footnote(p: number): Step | null {
    const t = this.text;
    const close = this.closeOf(p);
    if (close < 0 || t[close + 1] !== ':') return null;
    let end = t.indexOf('\n', close + 2);
    if (end < 0) end = this.n;
    const parts = [t.slice(close + 2, end)];
    for (;;) {
      FOOTNOTE_CONTINUE.lastIndex = end;
      const more = FOOTNOTE_CONTINUE.exec(t);
      if (!more) break;
      parts.push(more[0]);
      end += more[0].length;
    }
    const body = parts.map(part => part.trim()).filter(Boolean).join(' ');
    if (!body) return null;
    return { end, out: `[footnote: ${body}]`, labelled: true };
  }

  /**
   * What starts a line: a code fence (whose content is code, and whose info string is labelled after the language word,
   * since a renderer shows the language and not the rest), a footnote, or a reference definition. Null when none does.
   */
  private lineStart(at: number): Step | null {
    const t = this.text;
    FENCE_OPEN.lastIndex = at;
    const fence = FENCE_OPEN.exec(t);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) return this.fenced(at, fence);
    let p = at;
    while (p - at < 3 && t[p] === ' ') p++;
    if (t[p] === '[') return t[p + 1] === '^' ? this.footnote(p) : this.definition(p);
    return null;
  }

  private fenced(at: number, open: RegExpExecArray): Step {
    const t = this.text;
    const [, indent, marker, info] = open;
    const lineEnd = t.indexOf('\n', at);
    const trimmed = info.trim();
    const cut = trimmed.search(/\s/);
    const lang = cut < 0 ? trimmed : trimmed.slice(0, cut);
    const hidden = cut < 0 ? '' : trimmed.slice(cut).trim();
    const head = hidden
      ? `${indent}${marker}${info.match(/^\s*/)![0]}${lang} [code fence info: ${hidden}]`
      : open[0];
    if (lineEnd < 0) return { end: this.n, out: head, labelled: hidden !== '' };
    const ch = marker[0] === '`' ? '`' : '~';
    const closing = new RegExp('^ {0,3}' + ch + '{' + marker.length + ',}[ \\t\\r]*$');
    let end = this.n;
    for (let p = lineEnd + 1; p < this.n;) {
      let nl = t.indexOf('\n', p);
      if (nl < 0) nl = this.n;
      if (closing.test(t.slice(p, nl))) {
        end = nl;
        break;
      }
      p = nl + 1;
    }
    return { end, out: head + t.slice(at + open[0].length, end), labelled: hidden !== '' };
  }

  /** The position of the ']' that closes the '[' at `open`, or -1. Computed for the whole text once, in one pass. */
  private closeOf(open: number): number {
    if (!this.closers) {
      const pairs = new Int32Array(this.n).fill(-1);
      const stack: number[] = [];
      for (let i = 0; i < this.n; i++) {
        const c = this.text[i];
        if (c === '[' && !this.isEscaped(i)) stack.push(i);
        else if (c === ']' && !this.isEscaped(i) && stack.length > 0) pairs[stack.pop()!] = i;
      }
      this.closers = pairs;
    }
    return this.closers[open];
  }

  /** Whether the character at `at` is preceded by an odd number of backslashes, so it is escaped. */
  private isEscaped(at: number): boolean {
    if (!this.escaped) {
      const escaped = new Uint8Array(this.n);
      let run = 0;
      for (let i = 0; i < this.n; i++) {
        escaped[i] = run % 2;
        run = this.text[i] === '\\' ? run + 1 : 0;
      }
      this.escaped = escaped;
    }
    return this.escaped[at] === 1;
  }

  /** The first position at or after `from` whose character passes `test`, or the length of the text when none does. */
  private nextOf(key: string, test: (c: string) => boolean, from: number): number {
    let table = this.tables.get(key);
    if (table === undefined) {
      table = new Int32Array(this.n + 1);
      table[this.n] = this.n;
      for (let i = this.n - 1; i >= 0; i--) table[i] = test(this.text[i]) ? i : table[i + 1];
      this.tables.set(key, table);
    }
    return table[Math.min(from, this.n)];
  }

  private skipWhitespace(k: number): number {
    const t = this.text;
    while (k < this.n && (isBlank(t[k]) || t[k] === '\n')) k++;
    return k;
  }

  /** The first paragraph break at or after `at`: a '\n' that starts a blank line. The length of the text when none. */
  private breakFrom(at: number): number {
    if (!this.breaks) {
      const t = this.text;
      const isBreak = new Uint8Array(this.n);
      for (let i = 0; i < this.n; i++) {
        if (t[i] !== '\n') continue;
        let k = i + 1;
        while (k < this.n && isBlank(t[k])) k++;
        if (k < this.n && t[k] === '\n') isBreak[i] = 1;
      }
      const breaks = new Int32Array(this.n + 1);
      breaks[this.n] = this.n;
      for (let i = this.n - 1; i >= 0; i--) breaks[i] = isBreak[i] ? i : breaks[i + 1];
      this.breaks = breaks;
    }
    return this.breaks[Math.min(at, this.n)];
  }

  /** The start of each maximal backtick run, by its length, in order. */
  private tickRuns(): Map<number, number[]> {
    if (!this.ticks) {
      const runs = new Map<number, number[]>();
      const t = this.text;
      for (let i = 0; i < this.n;) {
        if (t[i] !== '`') {
          i++;
          continue;
        }
        let end = i;
        while (end < this.n && t[end] === '`') end++;
        const starts = runs.get(end - i) ?? [];
        starts.push(i);
        runs.set(end - i, starts);
        i = end;
      }
      this.ticks = runs;
    }
    return this.ticks;
  }

  /** Whether `at` lies inside a fenced code block. The blocks are the fence lines and what they enclose. */
  private inFence(at: number): boolean {
    if (!this.fences) this.fences = this.fenceRanges();
    const f = this.fences;
    let lo = 0;
    let hi = f.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f[2 * mid] <= at) lo = mid + 1;
      else hi = mid;
    }
    const k = lo - 1;
    return k >= 0 && at < f[2 * k + 1];
  }

  /** The fenced blocks of the text, as pairs of start and end positions. */
  private fenceRanges(): number[] {
    const t = this.text;
    const out: number[] = [];
    let open: { start: number; ch: string; len: number } | null = null;
    let s = 0;
    for (;;) {
      let e = t.indexOf('\n', s);
      if (e < 0) e = this.n;
      const line = t.slice(s, e);
      if (open === null) {
        const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (m && !(m[1][0] === '`' && m[2].includes('`'))) open = { start: s, ch: m[1][0], len: m[1].length };
      } else {
        const m = /^ {0,3}(`+|~+)[ \t\r]*$/.exec(line);
        if (m && m[1][0] === open.ch && m[1].length >= open.len) {
          out.push(open.start, e);
          open = null;
        }
      }
      if (e >= this.n) break;
      s = e + 1;
    }
    if (open !== null) out.push(open.start, this.n);
    return out;
  }
}
