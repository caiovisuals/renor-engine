import { refusal } from '../toolRefusal';

/**
 * The control characters a stored memory cannot keep.
 *
 * A memory is text that is read back verbatim — by an agent, by a log, by an editor, by a script that
 * splits on lines — so anything that is not printable text is REFUSED rather than written. The sharp
 * case is NUL (U+0000): both the filesystem and SQLite accept it, so a note carrying one is written,
 * indexed and served as though it were ordinary text, while every C-string boundary in a downstream
 * reader ends the line early. The rest of the class is the same argument: ESC and the other C0
 * controls carry no words, arrive by accident (a binary blob pasted as a note) or on purpose (a
 * terminal escape sequence that rewrites what a transcript shows), and are invisible in a diff.
 *
 * The set is the one this engine already uses for its structured fields (lifecycle.ts CONTROL_CHARS,
 * importing/facts.ts CONTROL_CHARS): every C0 control and DEL. Three are kept, because they are
 * whitespace a note legitimately holds:
 *
 *   TAB (U+0009), LF (U+000A) and CR (U+000D) — the carriage return of a Windows line ending. The
 *   chunker already splits a daily note on all three, and an entry a Windows user pastes arrives
 *   CRLF-terminated, so refusing CR would refuse real memories to fix none. VT and FF (U+000B,
 *   U+000C) are kept out: they are not the whitespace anyone types.
 *
 * Where this rule does NOT apply, and why:
 *
 *   - The ledger's `statement` field (memory/lifecycle.ts). It is written as ONE JSON string literal,
 *     which escapes every C0 control, so a statement keeps any character sequence without being able
 *     to break the ledger's framing — the property src/memory/statement-encoding.test.ts proves with
 *     a NUL, 4000 NULs, forged heading lines and JSON that tries to close the string. Refusing there
 *     would also make a ledger written by an earlier build un-replayable-by-resent (that test loads a
 *     literal separator and expects the same words to be a nochange resend).
 *   - The structured lifecycle fields (subject, predicate, object, source) in the same file: they
 *     already refuse this same set, and tab/newline too, because the ledger framing needs it.
 *   - REPLY text. Nothing stored is rewritten, and what a reader sees is made safe on the way out:
 *     escapeInvisibleControls (mvp/sanitize.ts) renders every C0 control, C1 control and format
 *     character as a `\uXXXX` escape in every JSON reply, so a stored value never applies a hidden
 *     character to a transcript while the archive keeps every character.
 *
 * One rule for every path that stores text RAW — the daily note, an imported Markdown note, a request
 * another agent reads — so the answer is the same whichever write tool the caller used.
 */
// An unpaired surrogate is refused too: SQLite and the files keep it as CESU-style bytes, and every reader
// shows it as three replacement characters. A valid pair is one code point, so emoji are not matched.
const UNSTORABLE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\p{Cs}/gu;

/** The distinct unstorable control characters `text` holds, as `U+XXXX`, in the order first seen. */
export function unstorableControls(text: string): string[] {
  // One pass over the text, and a second only over the offenders: a 64 KiB import note is matched once
  // here rather than tested character by character, which is what a per-code-point loop costs.
  const found = text.match(UNSTORABLE_CONTROL);
  if (found === null) return [];
  const codes: string[] = [];
  for (const ch of found) {
    const code = `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * Refuse `text` when it holds a control character a memory cannot keep, naming the code points so the
 * caller sees which one arrived. Nothing was written by any caller when this throws: every write path
 * checks before it opens the file or the ledger.
 */
export function assertNoUnstorableControls(field: string, text: string): void {
  const codes = unstorableControls(text);
  if (codes.length === 0) return;
  const one = codes.length === 1;
  throw refusal('invalid_text',
    `${field} contains ${one ? 'a control character' : 'control characters'} that cannot be stored as text (${codes.join(', ')}); the only C0 controls kept are tab, newline and carriage return, so remove ${one ? 'it' : 'them'} and send the text again. Nothing was written.`);
}
