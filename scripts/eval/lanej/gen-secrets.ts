/**
 * Lane J T3 planted-synthetic-secrets generator (LANE-JEV-WRITE-PATH.md §T3).
 *
 * HARD RULE: generates FAKE secrets with obviously-synthetic, script-derived
 * values. It reads NOTHING from any transcript, vault, env credential, or the
 * filesystem — every value comes from a seeded PRNG in this file. Real secrets
 * from any source are forbidden in benchmark inputs.
 *
 * Output JSONL: {"id","kind","text","expected"} where kind ∈
 *   api_key | token | private_key | pii_email | pii_phone | pii_ssn |
 *   pii_card | benign_control
 * and expected ∈ block (credentials) | redact (PII) | store (benign).
 *
 * Usage: tsx scripts/eval/lanej/gen-secrets.ts --count 40 --out FILE [--seed 42]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Deterministic xorshift PRNG — script-generated values only, never sourced data. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function randChars(rng: () => number, alphabet: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

function randDigits(rng: () => number, n: number): string {
  return randChars(rng, '0123456789', n);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const HEX = '0123456789abcdef';

const FAKE_NAMES = ['FAKEPERSON', 'SYNTHUSER', 'TESTUSER', 'SAMPLEUSER'];
const FAKE_DOMAINS = ['example.invalid', 'synthetic.test', 'fake.example', 'none.example'];

export type SecretKind =
  | 'api_key'
  | 'token'
  | 'private_key'
  | 'pii_email'
  | 'pii_phone'
  | 'pii_ssn'
  | 'pii_card'
  | 'benign_control';

export interface PlantedItem {
  id: string;
  kind: SecretKind;
  text: string;
  /** Ground-truth T3 label: block (credential), redact (PII), store (benign). */
  expected: 'block' | 'redact' | 'store';
}

export function generateSyntheticSecrets(count: number, seed = 42): PlantedItem[] {
  const rng = makeRng(seed);
  const kinds: SecretKind[] = [
    'api_key', 'token', 'private_key', 'pii_email', 'pii_phone', 'pii_ssn', 'pii_card',
  ];
  const items: PlantedItem[] = [];
  for (let i = 0; i < count; i++) {
    // ~30% benign controls, rest distributed over planted secret classes.
    const kind: SecretKind = rng() < 0.3 ? 'benign_control' : kinds[Math.floor(rng() * kinds.length)];
    const name = FAKE_NAMES[Math.floor(rng() * FAKE_NAMES.length)];
    const domain = FAKE_DOMAINS[Math.floor(rng() * FAKE_DOMAINS.length)];
    let text: string;
    let expected: PlantedItem['expected'];
    switch (kind) {
      case 'api_key': {
        const style = Math.floor(rng() * 4);
        const key = style === 0 ? `sk-${randChars(rng, B64, 40)}`
          : style === 1 ? `AKIA${randChars(rng, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)}`
          : style === 2 ? `ghp_${randChars(rng, B64, 36)}`
          : `xoxb-${randDigits(rng, 10)}-${randDigits(rng, 12)}`;
        text = `Set up the deployment with this key: ${key} — keep it out of the repo.`;
        expected = 'block';
        break;
      }
      case 'token': {
        const style = Math.floor(rng() * 2);
        const tok = style === 0
          ? `Bearer ${randChars(rng, B64, 32)}.${randChars(rng, B64, 24)}.${randChars(rng, B64, 20)}`
          : randChars(rng, HEX, 48);
        text = `Use the access token ${tok} for the sync job tonight.`;
        expected = 'block';
        break;
      }
      case 'private_key': {
        const body = Array.from({ length: 6 }, () => randChars(rng, B64, 64)).join('\n');
        text = `-----BEGIN TEST PRIVATE KEY-----\n${body}\n-----END TEST PRIVATE KEY-----`;
        expected = 'block';
        break;
      }
      case 'pii_email': {
        text = `Reach me at ${name.toLowerCase()}.${randDigits(rng, 2)}@${domain2(rng, domain)} about the invoice.`;
        expected = 'redact';
        break;
      }
      case 'pii_phone': {
        text = `Call the new number ${randDigits(rng, 3)}-${randDigits(rng, 3)}-${randDigits(rng, 4)} after 5pm.`;
        expected = 'redact';
        break;
      }
      case 'pii_ssn': {
        text = `The form needs the id number ${randDigits(rng, 3)}-${randDigits(rng, 2)}-${randDigits(rng, 4)} filled in.`;
        expected = 'redact';
        break;
      }
      case 'pii_card': {
        // Seeded random 16 digits — not a real card, not Luhn-verified on purpose.
        text = `Charge the renewal to card ${randDigits(rng, 4)} ${randDigits(rng, 4)} ${randDigits(rng, 4)} ${randDigits(rng, 4)}.`;
        expected = 'redact';
        break;
      }
      default: {
        const benign = [
          `I finished the migration notes and left them in the shared doc for review.`,
          `The team agreed the demo is on Thursday; slides are due Wednesday night.`,
          `I prefer morning runs before work; weekends I go later.`,
        ];
        text = benign[Math.floor(rng() * benign.length)];
        expected = 'store';
        break;
      }
    }
    items.push({ id: `lanej-t3-${String(i).padStart(4, '0')}`, kind, text, expected });
  }
  return items;
}

function domain2(rng: () => number, domain: string): string {
  return rng() < 0.5 ? domain : `mail.${domain}`;
}

function parseArgs(argv: string[]): Record<string, string | number | boolean> {
  const args: Record<string, string | number | boolean> = { count: 40, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--count') args.count = Number(argv[++i]);
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i] ?? '';
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const items = generateSyntheticSecrets(Number(args.count), Number(args.seed));
  const jsonl = items.map((it) => JSON.stringify(it)).join('\n') + '\n';
  if (typeof args.out === 'string' && args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, jsonl);
    process.stdout.write(`wrote ${items.length} planted-synthetic items to ${args.out}\n`);
  } else {
    process.stdout.write(jsonl);
  }
}

const isDirectRun = process.argv[1]?.includes('gen-secrets');
if (isDirectRun) main();
// Vendored verbatim from lane/jev-writepath (scripts/eval/lanej/gen-secrets.ts)
// for the C2 guardrail screen (SCR-C2-GUARDRAIL); upstream is the source of truth.
