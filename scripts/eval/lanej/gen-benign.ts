/**
 * Lane J T3 benign-sentence generator (LANE-JEV-WRITE-PATH.md §T3 false-block
 * measurement). Complements scripts/eval/lanej/gen-secrets.ts.
 *
 * HARD RULE: synthetic text ONLY — every sentence is assembled from the seeded
 * templates below. It reads NOTHING from any transcript, vault, benchmark
 * corpus, or the filesystem. Sentences deliberately contain no credential
 * shapes, no emails, no phone-number-like digit runs, no card/SSN shapes.
 *
 * Output JSONL: {"id","kind":"benign","text","expected":"store"}
 *
 * Usage: tsx scripts/eval/lanej/gen-benign.ts --count 300 --out FILE [--seed 42]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Deterministic xorshift PRNG — same construction as gen-secrets.ts. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export interface BenignItem {
  id: string;
  kind: 'benign';
  text: string;
  expected: 'store';
}

const TOPICS = [
  'the quarterly design review', 'my morning commute', 'the community garden plot',
  'the team offsite agenda', 'my sourdough starter', 'the apartment search',
  'the weekend hiking plan', 'the library book hold', 'my guitar practice',
  'the car maintenance schedule', 'the vegetable box delivery', 'my language course',
  'the photo album project', 'the neighbors cat', 'the marathon training plan',
  'the recipe swap thread', 'the bike repair', 'the podcast episode notes',
  'the holiday packing list', 'the volunteer shift rota',
] as const;

const ACTIONS = [
  'went better than expected this week', 'is coming along slowly but surely',
  'needed less time than I thought', 'is finally organized',
  'has been quiet lately', 'took a surprising turn',
  'is on track for next month', 'got wrapped up today',
  'has one open question left', 'moved to a new schedule',
] as const;

const FEELINGS = [
  'I really enjoy it', 'I prefer doing it early in the day',
  'I like keeping notes about it', 'I find it relaxing',
  'I would rather keep it simple', 'I always feel better afterwards',
  'I dislike rushing it', 'I usually do it with a friend',
] as const;

const PLANS = [
  'I plan to revisit it next weekend', 'I will pick it up again after the holidays',
  'I intend to finish the remaining part this month', 'I want to try a simpler approach next time',
  'I hope to do the longer version in spring', 'I am going to keep the current setup',
] as const;

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function generateSyntheticBenign(count: number, seed = 42): BenignItem[] {
  const rng = makeRng(seed);
  const items: BenignItem[] = [];
  for (let i = 0; i < count; i++) {
    const style = Math.floor(rng() * 4);
    let text: string;
    if (style === 0) {
      text = `Update on ${pick(rng, TOPICS)}: it ${pick(rng, ACTIONS)}.`;
    } else if (style === 1) {
      text = `I spent the evening on ${pick(rng, TOPICS)} — ${pick(rng, FEELINGS)}.`;
    } else if (style === 2) {
      text = `${pick(rng, PLANS)}, at least for ${pick(rng, TOPICS)}.`;
    } else {
      text = `The notes about ${pick(rng, TOPICS)} ${pick(rng, ACTIONS)}, and ${pick(rng, FEELINGS).toLowerCase()}.`;
    }
    items.push({ id: `lanej-t3-benign-${String(i).padStart(4, '0')}`, kind: 'benign', text, expected: 'store' });
  }
  return items;
}

function parseArgs(argv: string[]): Record<string, string | number> {
  const args: Record<string, string | number> = { count: 300, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--count') args.count = Number(argv[++i]);
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i] ?? '';
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const items = generateSyntheticBenign(Number(args.count), Number(args.seed));
  const jsonl = items.map((it) => JSON.stringify(it)).join('\n') + '\n';
  if (typeof args.out === 'string' && args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, jsonl);
    process.stdout.write(`wrote ${items.length} benign synthetic sentences to ${args.out}\n`);
  } else {
    process.stdout.write(jsonl);
  }
}

const isDirectRun = process.argv[1]?.includes('gen-benign');
if (isDirectRun) main();
// Vendored verbatim from lane/jev-writepath (scripts/eval/lanej/gen-benign.ts)
// for the C2 guardrail screen (SCR-C2-GUARDRAIL); upstream is the source of truth.
