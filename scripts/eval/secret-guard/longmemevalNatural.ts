/**
 * The natural half of the investigation's T3 set: 100 benign user turns from LongMemEval-S, rebuilt on demand.
 *
 * They are benchmark text, and the benchmark is never committed (engine/AGENTS.md), so what is in git is
 * `investigation-natural-turns.json`: each turn's id, where it sits in the dataset (session id and turn index) and the
 * SHA-256 of its text. This file is the sampler that picked them, ported line for line from the investigation's
 * `extract_lme.py` and `sample_t1.py` (random seed 20261002) and `gen_t3.py` (seed 77), on the exact port of
 * Python's generator in pythonRandom.ts. Given `longmemeval_s.json` it returns the same 100 turns in the same order,
 * and `rebuildNaturalTurns` proves it turn by turn against the pins before anything is measured.
 *
 * The port keeps three Python behaviours JavaScript does not have, because each can change which turn is picked:
 * `str.strip()` removes U+001C to U+001F and U+0085 but not U+FEFF; `len()` counts code points, not UTF-16 units; `\b`
 * and `re.I` are Unicode-aware (a letter of any script is a word character, and `i` also matches U+0130 and U+0131).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PyRandom } from './pythonRandom';

// ----------------------------------------------------------------------------- Python's string behaviour
const PY_SPACE = /[\t-\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]/u;

/** `str.strip()`. A loop, not a `\s+$` pattern: that one is quadratic on a long run of spaces. */
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && PY_SPACE.test(s[a])) a++;
  while (b > a && PY_SPACE.test(s[b - 1])) b--;
  return s.slice(a, b);
}

/** `len(s)`: code points. */
export const pyLen = (s: string): number => [...s].length;

/** The investigation's first-person filter, `re.compile(r"\b(i|i'm|…)\b", re.I)`, with Python's Unicode word boundary. */
const FIRST_PERSON = /(?<![\p{L}\p{N}_])(?:i|[\u{130}\u{131}]|i'm|i've|i'll|i'd|my|me|mine|we|our|we're|we've)(?![\p{L}\p{N}_])/iu;
export const hasFirstPerson = (text: string): boolean => FIRST_PERSON.test(text);

// ----------------------------------------------------------------------------- the dataset
interface LmeMessage { role?: string; content: string; has_answer?: boolean }
export interface LmeQuestion {
  haystack_session_ids: string[];
  haystack_sessions: LmeMessage[][];
}
export interface UserTurn { index: number; text: string; hasAnswer: boolean }
export interface Session { sid: string; kind: 'sim' | 'ultrachat' | 'sharegpt'; turns: UserTurn[] }

/** `extract_lme.py`: each session once (its first occurrence), in file order, with its user turns. */
export function userTurnsBySession(questions: readonly LmeQuestion[]): Session[] {
  const seen = new Map<string, Session>();
  for (const q of questions) {
    q.haystack_session_ids.forEach((sid, at) => {
      if (seen.has(sid)) return;
      const kind = sid.startsWith('sharegpt_') ? 'sharegpt' : sid.startsWith('ultrachat_') ? 'ultrachat' : 'sim';
      const turns: UserTurn[] = [];
      q.haystack_sessions[at].forEach((m, index) => {
        if (m.role === 'user') turns.push({ index, text: m.content, hasAnswer: Boolean(m.has_answer) });
      });
      seen.set(sid, { sid, kind, turns });
    });
  }
  return [...seen.values()];
}

export interface Candidate { sid: string; turn: number; text: string }
export type PoolSizes = Record<'evid' | 'sim_other' | 'ultra' | 'ultra_generic', number>;

const POOL_SEED = 20261002;
const NATURAL_SEED = 77;

/** `sample_t1.py`'s set A (300 turns, shuffled) and `gen_t3.py`'s pick of 100 from it. ShareGPT (real users) is excluded. */
export function sampleNaturalTurns(sessions: readonly Session[]): { turns: Candidate[]; poolSizes: PoolSizes } {
  const rng = new PyRandom(POOL_SEED);
  const pool: Record<keyof PoolSizes, Candidate[]> = { evid: [], sim_other: [], ultra: [], ultra_generic: [] };
  for (const s of sessions) {
    if (s.kind === 'sharegpt') continue;
    for (const t of s.turns) {
      const text = pyStrip(t.text);
      const n = pyLen(text);
      if (n < 25 || n > 1200) continue;
      const rec = { sid: s.sid, turn: t.index, text };
      if (s.kind === 'sim') (t.hasAnswer ? pool.evid : pool.sim_other).push(rec);
      else {
        pool.ultra.push(rec);
        if (!hasFirstPerson(t.text)) pool.ultra_generic.push(rec);
      }
    }
  }
  // Each pool is deduplicated by text, then shuffled, in this order: the fourth shuffle moves the generator on
  // even though set A does not use that pool.
  for (const k of ['evid', 'sim_other', 'ultra', 'ultra_generic'] as const) {
    const seenText = new Set<string>();
    const unique: Candidate[] = [];
    for (const x of pool[k]) {
      if (seenText.has(x.text)) continue;
      seenText.add(x.text);
      unique.push(x);
    }
    rng.shuffle(unique);
    pool[k] = unique;
  }
  const poolSizes: PoolSizes = { evid: pool.evid.length, sim_other: pool.sim_other.length, ultra: pool.ultra.length, ultra_generic: pool.ultra_generic.length };
  const take = (k: keyof PoolSizes, n: number) => pool[k].slice(0, n); // no pool is drawn from twice for set A
  const setA = [...take('evid', 70), ...take('sim_other', 150), ...take('ultra', 80)];
  rng.shuffle(setA);
  new PyRandom(NATURAL_SEED).shuffle(setA);
  return { turns: setA.slice(0, 100), poolSizes };
}

// ----------------------------------------------------------------------------- the pins
export interface NaturalPins {
  source: { file: string; sha256: string };
  sampler: { poolSeed: number; naturalSeed: number; poolSizes: PoolSizes };
  textsSha256: { natural: string; fullSet: string };
  turns: Array<{ id: string; sid: string; turn: number; sha256: string }>;
}

export const NATURAL_PINS_PATH = path.join(__dirname, 'investigation-natural-turns.json');
export const readNaturalPins = (): NaturalPins => JSON.parse(fs.readFileSync(NATURAL_PINS_PATH, 'utf8')) as NaturalPins;

export const sha256Hex = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');

export function readLongMemEval(file: string): LmeQuestion[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as LmeQuestion[];
}

/**
 * Rebuilds the natural turns from the dataset and proves they are the pinned ones. Returns their text, in order.
 * Throws, naming the first difference, when the dataset or the sampler is not what the pins were taken from.
 */
export function rebuildNaturalTurns(questions: readonly LmeQuestion[], pins: NaturalPins = readNaturalPins()): string[] {
  const { turns, poolSizes } = sampleNaturalTurns(userTurnsBySession(questions));
  for (const k of Object.keys(pins.sampler.poolSizes) as Array<keyof PoolSizes>) {
    if (poolSizes[k] !== pins.sampler.poolSizes[k]) throw new Error(`pool "${k}" holds ${poolSizes[k]} turns, the pins say ${pins.sampler.poolSizes[k]}: not the investigation's dataset`);
  }
  if (turns.length !== pins.turns.length) throw new Error(`${turns.length} natural turns sampled, ${pins.turns.length} pinned`);
  turns.forEach((t, i) => {
    const pin = pins.turns[i];
    if (t.sid !== pin.sid || t.turn !== pin.turn) throw new Error(`${pin.id}: sampled session ${t.sid} turn ${t.turn}, pinned ${pin.sid} turn ${pin.turn}`);
    if (sha256Hex(t.text) !== pin.sha256) throw new Error(`${pin.id}: the text of ${pin.sid} turn ${pin.turn} does not match its pinned sha256`);
  });
  const texts = turns.map(t => t.text);
  if (sha256Hex(texts.join('\n')) !== pins.textsSha256.natural) throw new Error('the natural turns joined do not match the pinned sha256');
  return texts;
}
