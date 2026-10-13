import type { LmeQuestion } from '../../scripts/eval/secret-guard/longmemevalNatural';

/**
 * A synthetic dataset in LongMemEval-S's shape, with every kind of user turn the natural-turn sampler has a rule
 * about, so the sampler can be tested against the Python original without the real benchmark:
 *
 *   - turns of exactly 24 and 25 characters, and 1,200 and 1,201, counted the way Python counts them: after
 *     `str.strip()` (which removes U+001C to U+001F and U+0085 but not U+FEFF) and in code points (an emoji is one);
 *   - first-person and generic UltraChat prompts, including a dotted and a dotless Turkish `i` (Python's `re.I` counts
 *     both as `i`) and an `i` glued to an accented letter (no word boundary in Python, one in JavaScript's `\b`);
 *   - a text shared by many sessions, a session id that appears twice with different content, a ShareGPT session
 *     (excluded), assistant and role-less messages, and `has_answer` on some user turns.
 *
 * Everything is a function of the index: no random numbers. The golden values the test compares with were produced by
 * running the investigation's own Python (`extract_lme.py`, `sample_t1.py`, `gen_t3.py`) on this exact dataset.
 */
const cp = String.fromCodePoint;
const DOTTED_I = cp(0x130);
const DOTLESS_I = cp(0x131);
const E_ACUTE = cp(0xe9);
const NEL = cp(0x85);
const US = cp(0x1f);
const FS = cp(0x1c);
const BOM = cp(0xfeff);
const GRIN = cp(0x1f600);

/** The user turn for variant `j`: the kind is `j % 20`. */
export function syntheticTurn(j: number): string {
  const body = (n: number) => `b${j}`.padEnd(n, 'x');
  switch (j % 20) {
    case 0: case 10: return `I think item ${j} needs a closer look, can you help me with it`;
    case 1: case 11: return `Write a short essay about topic number ${j} for a general audience`;
    case 2: case 12: return `${DOTTED_I} ${j} would like a recipe for dinner tonight with rice and beans`;
    case 3: case 13: return `${DOTLESS_I}i ${j} nothing here is first person, only a long enough text`;
    case 4: case 14: return `${E_ACUTE}i ${j} and more words to make this turn long enough to keep`;
    case 5: return `${NEL}${US}${body(24)}${FS} `; // 24 characters once Python strips it: too short
    case 15: return `${BOM}${body(24)}`; // 25 characters: Python keeps the BOM, JavaScript's trim() would not
    case 6: return `${GRIN.repeat(12)}${body(12)}`; // 24 code points (36 UTF-16 units): too short
    case 16: return `${GRIN.repeat(12)}${body(13)}`; // 25 code points
    case 7: case 17: return `The same sentence appears in several sessions, variant ${j % 3}, long enough to pass`;
    case 8: return `h${j}`.padEnd(1200, 'y'); // 1,200: kept
    case 18: return `h${j}`.padEnd(1201, 'y'); // 1,201: too long
    default: return `short ${j}`; // 9 and 19
  }
}

type Message = { role?: string; content: string; has_answer?: boolean };

function session(turns: Array<{ text: string; hasAnswer?: boolean }>, extra: Message[] = []): Message[] {
  const out: Message[] = [...extra];
  turns.forEach((t, n) => {
    out.push({ role: 'user', content: t.text, ...(t.hasAnswer ? { has_answer: true } : {}) });
    out.push({ role: 'assistant', content: `reply ${n}` });
  });
  return out;
}

export function syntheticLongMemEval(questions = 400): LmeQuestion[] {
  const out: LmeQuestion[] = [];
  for (let k = 0; k < questions; k++) {
    const ids = [`answer_${k}_1`, `${k.toString(16).padStart(8, '0')}_${k}`, `ultrachat_${k}`, `sharegpt_${k}`];
    const sessions = [
      session([{ text: syntheticTurn(3 * k), hasAnswer: true }, { text: syntheticTurn(3 * k + 1) }], [{ role: 'system', content: 'be brief' }, { content: 'no role' }]),
      session([{ text: syntheticTurn(3 * k + 2) }, { text: syntheticTurn(3 * k + 3) }]),
      session([{ text: syntheticTurn(3 * k + 4) }, { text: syntheticTurn(3 * k + 5) }]),
      session([{ text: syntheticTurn(3 * k + 6) }]),
    ];
    if (k > 0) {
      // an earlier session again, with other content: the first occurrence is the one that counts
      ids.push(`ultrachat_${k - 1}`);
      sessions.push(session([{ text: `a later copy of an earlier session, which must be ignored ${k}` }]));
    }
    out.push({ haystack_session_ids: ids, haystack_sessions: sessions });
  }
  return out;
}
