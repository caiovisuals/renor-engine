import zlib from 'node:zlib';
import type O200kPacked from './o200k.json';

/**
 * An exact o200k_base token COUNTER that holds the vocabulary as three typed arrays (about 4 MiB) instead of the
 * 200,000-entry Map of strings that `gpt-tokenizer` builds (about 45 MiB resident once loaded, measured against a running
 * workspace; see docs/performance/MEMORY-PER-WORKSPACE.md). It counts; it does not decode, and it never builds the token
 * list.
 *
 * WHAT "EXACT" MEANS HERE. For every string it returns the length of the list `gpt-tokenizer`'s `encode` returns for it
 * (with no special token allowed), because it runs the same three steps: split the text with the same regular expression;
 * a piece that is a whole token counts one; any other piece is merged byte pair by byte pair, lowest rank first. The
 * vocabulary comes from `gpt-tokenizer` itself through scripts/tokenizer/gen-o200k.cjs (src/indexer/o200k.json is its
 * output), and tests/indexer/o200k-counter.test.ts compares this counter with `gpt-tokenizer` on a fixed corpus and on a
 * seeded fuzz of every text shape that has bitten a tokenizer here: multi-byte text, emoji, lone surrogates, byte-order
 * marks, control characters, long runs, special-token spellings.
 *
 * THE QUIRKS KEPT, because "the same count" includes them:
 *   - `gpt-tokenizer` looks a byte key up as a STRING when the bytes are valid UTF-8, and its decoder drops a leading
 *     byte-order mark. So a key that starts with EF BB BF and is valid is looked up WITHOUT those three bytes, and the nine
 *     vocabulary entries that start with a mark can never be found by their own bytes. The generator packs those nine as
 *     empty entries, which `buildTable` does not insert.
 *   - A piece with a lone surrogate never matches a token as a whole string; it is merged over the bytes of its U+FFFD.
 *   - `disallowedSpecial` is a choice: `countStrict` throws on the spelling of a special token the way `encode` does by
 *     default, and `count` counts those spellings as ordinary text (`disallowedSpecial: new Set()`).
 *
 * LAZY, TWICE: nothing here runs at import (the packed vocabulary is inflated and indexed on the first count), and the
 * data module is a plain `require` for the same reason as tokenizer.ts: a start that never counts a token never pays for it.
 */

/** gpt-tokenizer's O200K_TOKEN_SPLIT_REGEX, character for character. */
const CONTRACTION = String.raw`'(?:[sS]|[dD]|[mM]|[tT]|[lL][lL]|[vV][eE]|[rR][eE])`;
const OPTIONAL_CONTRACTION = String.raw`(?:${CONTRACTION})?`;
const SPLIT_PATTERN = String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+${OPTIONAL_CONTRACTION}|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*${OPTIONAL_CONTRACTION}|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+`;

/** The eight spellings `encode` refuses by default, in the order its pattern lists them. */
const SPECIAL_SPELLINGS = ['<|endoftext|>', '<|fim_prefix|>', '<|fim_middle|>', '<|fim_suffix|>', '<|im_start|>', '<|im_end|>', '<|im_sep|>', '<|endofprompt|>'];
const SPECIAL_PATTERN = new RegExp(SPECIAL_SPELLINGS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

interface Table {
  /** All token bytes, back to back, in rank order. */
  bytes: Uint8Array;
  /** Token `r` is bytes[offsets[r] .. offsets[r + 1]); an empty range is a token that is not insertable. */
  offsets: Uint32Array;
  /** Open-addressing hash of the token bytes -> rank + 1 (0 = empty slot). */
  slots: Int32Array;
  mask: number;
}

let table: Table | null = null;
let splitter: RegExp | null = null;
let scratch = new Uint8Array(4096);
const encoder = new TextEncoder();

function hashBytes(b: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return h >>> 0;
}

function buildTable(): Table {
  // A plain require, not an import: the data is 1.4 MB of JSON and nothing may read it before the first count. JSON, not a .ts
  // module, so it needs no compiler pass and a plain `require` finds it from the source tree and from dist alike
  // (tsc copies a JSON file named by the `import type` above).
  const data = require('./o200k.json') as typeof O200kPacked;
  const O200K_TOKEN_COUNT = data.tokens;
  const packed = zlib.inflateSync(Buffer.from(data.deflateBase64, 'base64'));
  // The module cache would keep the 1.4 MB base64 string for the life of the process, and it is never read again.
  delete require.cache[require.resolve('./o200k.json')];
  const offsets = new Uint32Array(O200K_TOKEN_COUNT + 1);
  const bytes = new Uint8Array(packed.length);
  let read = 0;
  let write = 0;
  for (let rank = 0; rank < O200K_TOKEN_COUNT; rank++) {
    let len = 0;
    let shift = 0;
    for (;;) {
      const byte = packed[read++];
      len |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    offsets[rank] = write;
    bytes.set(packed.subarray(read, read + len), write);
    read += len;
    write += len;
  }
  offsets[O200K_TOKEN_COUNT] = write;
  let size = 1;
  while (size < O200K_TOKEN_COUNT * 2) size <<= 1;
  const slots = new Int32Array(size);
  const mask = size - 1;
  for (let rank = 0; rank < O200K_TOKEN_COUNT; rank++) {
    const start = offsets[rank];
    const end = offsets[rank + 1];
    if (end === start) continue;
    let slot = hashBytes(bytes, start, end) & mask;
    while (slots[slot] !== 0) slot = (slot + 1) & mask;
    slots[slot] = rank + 1;
  }
  // The packed buffer is not kept: `bytes` is its own copy, trimmed to what the tokens use.
  return { bytes: bytes.slice(0, write), offsets, slots, mask };
}

/** The rank of the token spelled by key[start..end), or -1. */
function rankOf(t: Table, key: Uint8Array, start: number, end: number): number {
  let slot = hashBytes(key, start, end) & t.mask;
  const len = end - start;
  for (;;) {
    const entry = t.slots[slot];
    if (entry === 0) return -1;
    const rank = entry - 1;
    const from = t.offsets[rank];
    if (t.offsets[rank + 1] - from === len) {
      let i = 0;
      while (i < len && t.bytes[from + i] === key[start + i]) i++;
      if (i === len) return rank;
    }
    slot = (slot + 1) & t.mask;
  }
}

/** gpt-tokenizer's own UTF-8 test (not the platform's: it differs on a few edge sequences), kept for the byte-order-mark rule. */
function isValidUtf8(b: Uint8Array, start: number, end: number): boolean {
  let i = start;
  while (i < end) {
    const byte1 = b[i];
    let n: number;
    let cp: number;
    if (byte1 <= 0x7f) { n = 1; cp = byte1; }
    else if ((byte1 & 0xe0) === 0xc0) { n = 2; cp = byte1 & 0x1f; if (byte1 <= 0xc1) return false; }
    else if ((byte1 & 0xf0) === 0xe0) { n = 3; cp = byte1 & 0x0f; }
    else if ((byte1 & 0xf8) === 0xf0) { n = 4; cp = byte1 & 0x07; if (byte1 > 0xf4) return false; }
    else return false;
    if (i + n > end) return false;
    for (let j = 1; j < n; j++) {
      const byte = b[i + j];
      if ((byte & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (byte & 0x3f);
    }
    if (n === 2 && cp < 0x80) return false;
    if (n === 3 && cp < 2048) return false;
    if (n === 4 && cp < 65536) return false;
    if (cp >= 55296 && cp <= 57343) return false;
    if (cp > 1114111) return false;
    i += n;
  }
  return true;
}

/** `getBpeRankFromBytes`: a key that reads as text is looked up as the decoded string, whose leading mark the decoder drops. */
function rankOfBytes(t: Table, key: Uint8Array, start: number, end: number): number {
  if (end - start >= 3 && key[start] === 0xef && key[start + 1] === 0xbb && key[start + 2] === 0xbf && isValidUtf8(key, start, end)) {
    return rankOf(t, key, start + 3, end);
  }
  return rankOf(t, key, start, end);
}

/** The number of tokens `bytePairMerge` leaves for these bytes: pairs merge lowest rank first, leftmost on a tie. */
function mergedCount(t: Table, piece: Uint8Array, length: number): number {
  const starts: number[] = [];
  const ranks: number[] = [];
  const rankAt = (i: number, a = starts[i], b = starts[i + 2]): number => {
    if (b === undefined) return Infinity;
    const r = rankOfBytes(t, piece, a, b);
    return r < 0 ? Infinity : r;
  };
  for (let i = 0; i <= length; i++) {
    starts.push(i);
    ranks.push(i < length - 1 ? rankAt(i, i, i + 2) : Infinity);
  }
  while (starts.length > 1) {
    let lowest = Infinity;
    let at = -1;
    for (let i = 0; i < ranks.length - 1; i++) {
      if (ranks[i] < lowest) { lowest = ranks[i]; at = i; }
    }
    if (lowest === Infinity || at === -1) break;
    starts.splice(at + 1, 1);
    ranks.splice(at, 1);
    ranks[at] = rankAt(at);
    if (at > 0) ranks[at - 1] = rankAt(at - 1);
  }
  return starts.length - 1;
}

/** A high surrogate not followed by a low one, or a low one not preceded by a high one (String.prototype.isWellFormed, which the build's lib lacks). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Pieces counted recently. A reply is budgeted from the same notes again and again, so the same words come back; gpt-tokenizer
 * kept up to 100,000 merge results for this (and ~10 MiB with them). This keeps the last few thousand and starts over when
 * full (~0.3 MiB at most): the count of a piece never depends on the cache, only the time.
 *
 * The table is open-addressed and looked up by the characters of the piece where they stand in the text, so a piece that is
 * already counted is found without making a string of it (a `Map` needs the string, and a call counts a few thousand
 * pieces). A string is made only for a piece that is new.
 */
const PIECE_CACHE_LIMIT = 4096;
const PIECE_SLOTS = 8192;
const PIECE_MASK = PIECE_SLOTS - 1;
/** '' marks a free slot: no piece is empty. Made on the first count, like the vocabulary. */
let pieceKeys: string[] | null = null;
let pieceHashes: Int32Array | null = null;
let pieceCounts: Int32Array | null = null;
let piecesKept = 0;

/** The tokens of `text.slice(start, end)`, which is not empty. */
function countPiece(t: Table, text: string, start: number, end: number): number {
  const keys = pieceKeys ??= new Array<string>(PIECE_SLOTS).fill('');
  const hashes = pieceHashes ??= new Int32Array(PIECE_SLOTS);
  const counts = pieceCounts ??= new Int32Array(PIECE_SLOTS);
  const length = end - start;
  let hash = 0x811c9dc5;
  for (let k = start; k < end; k++) hash = Math.imul(hash ^ text.charCodeAt(k), 0x01000193);
  let slot = hash & PIECE_MASK;
  for (;;) {
    const key = keys[slot];
    if (key === '') break;
    if (hashes[slot] === hash && key.length === length) {
      let k = 0;
      while (k < length && key.charCodeAt(k) === text.charCodeAt(start + k)) k++;
      if (k === length) return counts[slot];
    }
    slot = (slot + 1) & PIECE_MASK;
  }
  const piece = text.slice(start, end);
  const n = countPieceUncached(t, piece);
  if (piecesKept >= PIECE_CACHE_LIMIT) {
    keys.fill('');
    piecesKept = 0;
    slot = hash & PIECE_MASK;
  }
  keys[slot] = piece;
  hashes[slot] = hash;
  counts[slot] = n;
  piecesKept++;
  return n;
}

function countPieceUncached(t: Table, piece: string): number {
  // At most 3 bytes per UTF-16 unit; encodeInto never writes more.
  const need = piece.length * 3;
  if (scratch.length < need) scratch = new Uint8Array(Math.max(need, scratch.length * 2));
  const written = encoder.encodeInto(piece, scratch).written;
  // A whole-token piece counts one. Only a well-formed string can be a vocabulary key: a lone surrogate has no spelling.
  if (!LONE_SURROGATE.test(piece) && rankOf(t, scratch, 0, written) >= 0) return 1;
  return mergedCount(t, scratch, written);
}

/**
 * THE SPLIT WITHOUT THE PATTERN. SPLIT_PATTERN is the definition of where a text is cut into pieces, and it costs about 75 ns a
 * character (Unicode property classes, one match array and one string for every piece): the largest single part of counting a
 * reply, which counts a few thousand pieces. A text with no surrogate unit is cut by `pieceEnd` below instead, which makes
 * the same cuts by the pattern's own rules and allocates nothing.
 *
 * It is the pattern's seven alternatives, tried at each position in the pattern's order and with its backtracking spelled out
 * (the comments in `pieceEnd` say which). A character matters to the pattern only through which of its classes it is in,
 * and a unit's classes are worked out the first time it is met, by those same classes (`classify`), so the scan cannot
 * disagree with the pattern about a character; it can only disagree about the grammar, and tests/indexer/o200k-counter.test.ts
 * holds every count equal to gpt-tokenizer's over strings made of every class (all of them, up to six characters).
 * A text with a surrogate unit (an emoji, any character above U+FFFF, a lone half) goes through the pattern, as before.
 */
const KNOWN = 0x80;
/** [\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}] */
const UPPER = 0x01;
/** [\p{Ll}\p{Lm}\p{Lo}\p{M}] */
const LOWER = 0x02;
/** \p{L} */
const LETTER = 0x04;
/** \p{N} */
const NUMBER = 0x08;
/** \r or \n */
const BREAK = 0x10;
/** \s */
const SPACE = 0x20;

const SURROGATE_UNIT = /[\uD800-\uDFFF]/;
let classes: Uint8Array | null = null;
let classTests: { upper: RegExp; lower: RegExp; letter: RegExp; number: RegExp; space: RegExp } | null = null;

/** The classes of a UTF-16 unit that is not a surrogate, kept in `classes` for the next time. */
function classify(unit: number): number {
  const tests = classTests ??= {
    upper: /[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]/u, lower: /[\p{Ll}\p{Lm}\p{Lo}\p{M}]/u, letter: /\p{L}/u, number: /\p{N}/u, space: /\s/u,
  };
  const ch = String.fromCharCode(unit);
  let bits = KNOWN;
  if (tests.upper.test(ch)) bits |= UPPER;
  if (tests.lower.test(ch)) bits |= LOWER;
  if (tests.letter.test(ch)) bits |= LETTER;
  if (tests.number.test(ch)) bits |= NUMBER;
  if (unit === 0x0a || unit === 0x0d) bits |= BREAK;
  if (tests.space.test(ch)) bits |= SPACE;
  classes![unit] = bits;
  return bits;
}

function classAt(cls: Uint8Array, text: string, at: number): number {
  const unit = text.charCodeAt(at);
  return cls[unit] || classify(unit);
}

/** The end of the optional contraction ('s 'd 'm 't 'll 've 're, either case) that may follow a word ending at `at`: `at` when there is none. */
function contractionEnd(text: string, at: number, n: number): number {
  if (at + 1 >= n || text.charCodeAt(at) !== 0x27) return at;
  // `| 0x20` reads an ASCII letter of either case as its lower case, and no other unit as one of these letters.
  const first = text.charCodeAt(at + 1) | 0x20;
  if (first === 0x73 || first === 0x64 || first === 0x6d || first === 0x74) return at + 2;
  if (at + 2 >= n) return at;
  const second = text.charCodeAt(at + 2) | 0x20;
  return (first === 0x6c && second === 0x6c) || ((first === 0x76 || first === 0x72) && second === 0x65) ? at + 3 : at;
}

/** [Upper]* [Lower]+ (contraction)? from `from`: the end, or -1. The greedy upper run gives characters back one at a time until a lower one can start. */
function wordEnd(cls: Uint8Array, text: string, from: number, n: number): number {
  let upper = from;
  while (upper < n && (classAt(cls, text, upper) & UPPER) !== 0) upper++;
  for (let start = upper; start >= from; start--) {
    if (start < n && (classAt(cls, text, start) & LOWER) !== 0) {
      let end = start + 1;
      while (end < n && (classAt(cls, text, end) & LOWER) !== 0) end++;
      return contractionEnd(text, end, n);
    }
  }
  return -1;
}

/** [Upper]+ [Lower]* (contraction)? from `from`: the end, or -1. */
function shoutEnd(cls: Uint8Array, text: string, from: number, n: number): number {
  let end = from;
  while (end < n && (classAt(cls, text, end) & UPPER) !== 0) end++;
  if (end === from) return -1;
  while (end < n && (classAt(cls, text, end) & LOWER) !== 0) end++;
  return contractionEnd(text, end, n);
}

/** Whether a character that is not a space, a letter or a number: what alternative 4 runs over. */
const isOther = (bits: number): boolean => (bits & (SPACE | LETTER | NUMBER)) === 0;

/** The end of the piece the pattern cuts at `at` (always past it) in a text with no surrogate unit. */
function pieceEnd(cls: Uint8Array, text: string, at: number, n: number): number {
  // The commonest piece of prose, [ ]?[a-z]+, found without the classes: when the unit after it is ASCII and no apostrophe,
  // nothing can carry the word on (of the ASCII units only a to z are lower case) and no contraction starts.
  let word = text.charCodeAt(at) === 0x20 ? at + 1 : at;
  if (word < n) {
    let unit = text.charCodeAt(word);
    if (unit >= 0x61 && unit <= 0x7a) {
      while (++word < n && (unit = text.charCodeAt(word)) >= 0x61 && unit <= 0x7a);
      if (word >= n || (unit < 0x80 && unit !== 0x27)) return word;
    }
  }
  const first = classAt(cls, text, at);
  // 3, ahead of the words: a number is no letter and is not in front of a word, so alternatives 1 and 2 cannot match at it.
  // One to three numbers.
  if ((first & NUMBER) !== 0) {
    let end = at + 1;
    while (end < n && end < at + 3 && (classAt(cls, text, end) & NUMBER) !== 0) end++;
    return end;
  }
  // 1 and 2: a word, with one character in front of it that is no letter, number or line break; the word with the
  // character is tried first, then the word alone, in each alternative.
  const lead = (first & (BREAK | LETTER | NUMBER)) === 0;
  let end = lead ? wordEnd(cls, text, at + 1, n) : -1;
  if (end < 0) end = wordEnd(cls, text, at, n);
  if (end < 0 && lead) end = shoutEnd(cls, text, at + 1, n);
  if (end < 0) end = shoutEnd(cls, text, at, n);
  if (end >= 0) return end;
  // 4: [ ]?[^\s\p{L}\p{N}]+[\r\n/]*. A space in front is taken when something that is not a space, letter or number follows.
  if (text.charCodeAt(at) === 0x20) {
    if (at + 1 < n && isOther(classAt(cls, text, at + 1))) {
      end = at + 2;
      while (end < n && isOther(classAt(cls, text, end))) end++;
      while (end < n && (text.charCodeAt(end) === 0x0d || text.charCodeAt(end) === 0x0a || text.charCodeAt(end) === 0x2f)) end++;
      return end;
    }
  } else if (isOther(first)) {
    end = at + 1;
    while (end < n && isOther(classAt(cls, text, end))) end++;
    while (end < n && (text.charCodeAt(end) === 0x0d || text.charCodeAt(end) === 0x0a || text.charCodeAt(end) === 0x2f)) end++;
    return end;
  }
  // 5, 6 and 7: white space. 5 is \s*[\r\n]+ (the run up to its last line break), 6 is \s+(?!\S) (the run, or all of it but
  // the last character when a character that is not white space follows), 7 is \s+.
  if ((first & SPACE) !== 0) {
    let run = at + 1;
    while (run < n && (classAt(cls, text, run) & SPACE) !== 0) run++;
    for (let k = run - 1; k >= at; k--) if ((classAt(cls, text, k) & BREAK) !== 0) return k + 1;
    return run === n || run - at < 2 ? run : run - 1;
  }
  return -1;
}

function countBySplit(t: Table, text: string): number {
  const cls = classes ??= new Uint8Array(65536);
  const n = text.length;
  let total = 0;
  for (let at = 0; at < n;) {
    const end = pieceEnd(cls, text, at, n);
    if (end < 0) { at++; continue; } // no alternative matches here: the pattern moves on
    // A single ASCII unit is one byte, and every byte is a token.
    total += end - at === 1 && text.charCodeAt(at) < 0x80 ? 1 : countPiece(t, text, at, end);
    at = end;
  }
  return total;
}

function countByPattern(t: Table, text: string): number {
  const re = splitter ??= new RegExp(SPLIT_PATTERN, 'gu');
  let total = 0;
  for (const match of text.matchAll(re)) total += countPiece(t, text, match.index!, match.index! + match[0].length);
  return total;
}

function countText(text: string): number {
  const t = table ??= buildTable();
  return SURROGATE_UNIT.test(text) ? countByPattern(t, text) : countBySplit(t, text);
}

/** Tokens in `text`, special-token spellings counted as ordinary text (gpt-tokenizer's `{ disallowedSpecial: new Set() }`). */
export function countO200k(text: string): number {
  return countText(text);
}

/** Tokens in `text`, throwing on a special-token spelling the way gpt-tokenizer's default `encode` does. */
export function countO200kStrict(text: string): number {
  const match = text.match(SPECIAL_PATTERN);
  if (match !== null) throw new Error(`Disallowed special token found: ${match[0]}`);
  return countText(text);
}

/** True once the vocabulary has been inflated. Diagnostics and tests. */
export function o200kLoaded(): boolean {
  return table !== null;
}
