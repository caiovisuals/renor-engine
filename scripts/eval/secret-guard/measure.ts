/**
 * Measures the two things a write-path secret guard could do with text the tier-0 scanner flags:
 *
 *   refuse  the save is refused and nothing is stored (what the guard does)
 *   redact  the save goes ahead with each flagged span replaced by a placeholder (NOT shipped; here only to
 *           be measured against refusing). Two redactors, because the scanner knows THAT a secret is stated,
 *           not where it ends: "match" replaces exactly what a rule matched; "extended" also replaces the rest
 *           of the line after a cue phrase and the whole block of a private key.
 *
 * on planted synthetic secrets and on benign text. Docs: docs/evals/results/SECRET-GUARD-TIER0-20261003.md.
 *
 * Refuse:  recall = planted items refused; false block = benign items refused. A refused item stores nothing.
 * Redact:  a planted item is protected only if none of its planted values survives in the stored text
 *          ("leak-free"), which is stricter than the scanner flagging it; a benign item that is changed at
 *          all is a false redaction, and the share of its characters that were replaced is the damage.
 *
 * Usage (Node 22, from engine/):
 *   npx tsx scripts/eval/secret-guard/measure.ts                       # the investigation's synthetic sets, then the mirror sets
 *   npx tsx scripts/eval/secret-guard/measure.ts --longmemeval ~/bench-data/longmemeval_s.json
 *                                                                      # the investigation's T3 whole, natural turns included
 *   npx tsx scripts/eval/secret-guard/measure.ts --set t3=t3_set.jsonl --texts natural=natural.jsonl --json out.json
 * A --set file holds one {id, kind, text, gold, secrets?} per line (gold: block | redact | store); a --texts
 * file one {text} per line, all benign.
 *
 * The investigation's sets are regenerated exactly (investigationSets.ts). Its natural turns are benchmark text
 * that is never committed: --longmemeval rebuilds them from the dataset and refuses to measure unless they are
 * the pinned turns (longmemevalNatural.ts).
 */
import fs from 'node:fs';
import { SECRET_RULES, scanSecrets } from '../../../src/extraction/secretScanner';
import { buildInvestigationRobustness, buildInvestigationT3, textsSha256, withNaturalTurns } from './investigationSets';
import { readLongMemEval, readNaturalPins, rebuildNaturalTurns, userTurnsBySession, type LmeQuestion } from './longmemevalNatural';
import { buildPlantedSet, buildRobustnessSet, type PlantedItem } from './plantedSet';

// ----------------------------------------------------------------------------- the redact arm (measurement only)
interface Span { start: number; end: number; rule: string }

const lineEnd = (text: string, from: number) => {
  const nl = text.indexOf('\n', from);
  return nl < 0 ? text.length : nl;
};

/** A private key is the whole block, not its first line. */
function pemEnd(text: string, from: number): number {
  const end = /-----END [A-Z ]*PRIVATE KEY-----/.exec(text.slice(from));
  return end ? from + end.index + end[0].length : text.length;
}

export function flaggedSpans(text: string, extend: boolean): Span[] {
  const spans: Span[] = [];
  for (const rule of SECRET_RULES) {
    if (rule.needs && text.search(rule.needs) < 0) continue;
    for (const m of text.matchAll(rule.re)) {
      const start = m.index ?? 0;
      if (rule.accept && !rule.accept(m[0], text, start)) continue;
      let end = start + m[0].length;
      // The URL rule matches only the "://" and keeps the rest of the URL in a lookahead (group 1).
      if (rule.id === 'url-with-password') end += m[1]?.length ?? 0;
      // The scanner finds THAT a credential is stated, and the first word of it. The values it guards run on:
      // a seed phrase, a list of codes, the rest of a key block.
      if (extend && rule.id === 'credential-in-words') end = lineEnd(text, end);
      if (extend && rule.id === 'private-key') end = pemEnd(text, end);
      spans.push({ start, end, rule: rule.id });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** Neutral on purpose: a placeholder that holds a cue word ("credential") makes the redacted text flag itself on the next save. */
const REDACTED = '[redacted]';

export function redact(text: string, extend: boolean): string {
  let out = '';
  let at = 0;
  for (const s of flaggedSpans(text, extend)) {
    out += text.slice(at, s.start) + REDACTED;
    at = s.end;
  }
  return out + text.slice(at);
}

// ----------------------------------------------------------------------------- metrics
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = (k: number, n: number) => {
  if (n === 0) return 'n/a';
  const digits = k / n < 0.01 ? 3 : 1;
  return `${k}/${n} = ${((100 * k) / n).toFixed(digits)}% [${wilson(k, n).map(x => (100 * x).toFixed(digits === 3 ? 3 : 0)).join('-')}]`;
};

export interface SetResult {
  name: string;
  /** SHA-256 of the item texts joined by a newline: how a set is pinned. */
  textsSha256: string;
  items: number;
  planted: number;
  benign: number;
  refuse: {
    recall: [number, number];
    credentialRecall: [number, number];
    identifierRecall: [number, number];
    falseBlock: [number, number];
    missed: Record<string, number>;
    falseBlockKinds: Record<string, number>;
  };
  redactMatch: RedactStats;
  redactExtended: RedactStats;
}

export interface RedactStats {
  detected: [number, number];
  /** Planted items with a nameable value, none of which survives. */
  leakFree: [number, number];
  /** Flagged and redacted, but a planted value still survives. */
  flaggedStillLeaking: number;
  falseRedact: [number, number];
  /** Of the characters in the benign items that were altered: how many were replaced. */
  alteredItemCharsReplaced: [number, number];
  /** Redacted output the scanner still flags. */
  residualFlagged: number;
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

function redactStats(planted: readonly PlantedItem[], benign: readonly PlantedItem[], extend: boolean): RedactStats {
  let detected = 0, judged = 0, leakFree = 0, flaggedStillLeaking = 0, residual = 0;
  for (const it of planted) {
    const out = redact(it.text, extend);
    if (out !== it.text) detected++;
    if (scanSecrets(out)) residual++;
    if (it.secrets.length === 0) continue;
    judged++;
    if (it.secrets.every(sec => !out.includes(sec))) leakFree++;
    else if (scanSecrets(it.text)) flaggedStillLeaking++;
  }
  let falseRedact = 0, replaced = 0, chars = 0;
  for (const it of benign) {
    if (redact(it.text, extend) === it.text) continue;
    falseRedact++;
    chars += it.text.length;
    replaced += flaggedSpans(it.text, extend).reduce((a, sp) => a + (sp.end - sp.start), 0);
  }
  return {
    detected: [detected, planted.length], leakFree: [leakFree, judged], flaggedStillLeaking,
    falseRedact: [falseRedact, benign.length], alteredItemCharsReplaced: [replaced, chars], residualFlagged: residual,
  };
}

export function measureSet(name: string, items: readonly PlantedItem[]): SetResult {
  const planted = items.filter(i => i.gold !== 'store');
  const benign = items.filter(i => i.gold === 'store');
  const missed: Record<string, number> = {};
  const falseBlockKinds: Record<string, number> = {};
  let flagged = 0, credFlagged = 0, credTotal = 0, idFlagged = 0, idTotal = 0, falseBlock = 0;
  for (const it of planted) {
    const f = scanSecrets(it.text);
    if (it.gold === 'block') credTotal++; else idTotal++;
    if (f) { flagged++; if (it.gold === 'block') credFlagged++; else idFlagged++; } else bump(missed, it.kind);
  }
  for (const it of benign) {
    if (scanSecrets(it.text)) { falseBlock++; bump(falseBlockKinds, it.kind); }
  }
  return {
    name, textsSha256: textsSha256(items), items: items.length, planted: planted.length, benign: benign.length,
    refuse: {
      recall: [flagged, planted.length], credentialRecall: [credFlagged, credTotal], identifierRecall: [idFlagged, idTotal],
      falseBlock: [falseBlock, benign.length], missed, falseBlockKinds,
    },
    redactMatch: redactStats(planted, benign, false),
    redactExtended: redactStats(planted, benign, true),
  };
}

export interface TextsResult {
  name: string;
  texts: number;
  flagged: number;
  byRule: Record<string, number>;
  /** Of the characters in the flagged texts: how many each redactor replaced. */
  charsReplaced: { match: [number, number]; extended: [number, number] };
}

export function measureTexts(name: string, texts: Iterable<string>): TextsResult {
  const byRule: Record<string, number> = {};
  let n = 0, flagged = 0, chars = 0, replacedMatch = 0, replacedExtended = 0;
  for (const t of texts) {
    n++;
    const f = scanSecrets(t);
    if (!f) continue;
    flagged++;
    chars += t.length;
    bump(byRule, f.rule);
    replacedMatch += flaggedSpans(t, false).reduce((a, sp) => a + (sp.end - sp.start), 0);
    replacedExtended += flaggedSpans(t, true).reduce((a, sp) => a + (sp.end - sp.start), 0);
  }
  return { name, texts: n, flagged, byRule, charsReplaced: { match: [replacedMatch, chars], extended: [replacedExtended, chars] } };
}

/**
 * The investigation's own sets, regenerated exactly. With the dataset the natural turns are rebuilt and added
 * (443 items, as it measured them); `rebuildNaturalTurns` throws unless they are the pinned turns.
 */
export function investigationSets(longMemEval?: readonly LmeQuestion[]): SetResult[] {
  const synthetic = buildInvestigationT3();
  let t3 = synthetic;
  if (longMemEval !== undefined) {
    t3 = withNaturalTurns(synthetic, rebuildNaturalTurns(longMemEval));
    if (textsSha256(t3) !== readNaturalPins().textsSha256.fullSet) throw new Error('the 443 texts together do not match the pinned sha256');
  }
  return [
    measureSet(longMemEval === undefined ? 'investigation:t3-synthetic' : 'investigation:t3', t3),
    measureSet('investigation:robustness', buildInvestigationRobustness()),
  ];
}

/** Every user turn of the benchmark, ShareGPT (real users) excluded: 82,724 of them, none holding a planted secret. */
export function measureNaturalTurns(longMemEval: readonly LmeQuestion[]): TextsResult {
  const turns = userTurnsBySession(longMemEval).filter(s => s.kind !== 'sharegpt').flatMap(s => s.turns.map(t => t.text));
  return measureTexts('longmemeval:user-turns', turns);
}

// ----------------------------------------------------------------------------- reporting
const readJsonl = <T>(path: string): T[] => fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);

function printRedact(label: string, b: RedactStats): void {
  console.log(`  ${label}  flagged and altered   `, pct(...b.detected));
  console.log('          leak-free             ', pct(...b.leakFree), `(planted items with a nameable value; ${b.flaggedStillLeaking} were flagged and still leak)`);
  console.log('          false redaction       ', pct(...b.falseRedact), `; of the altered items' ${b.alteredItemCharsReplaced[1]} characters, ${b.alteredItemCharsReplaced[0]} replaced`);
  console.log('          output still flagged  ', b.residualFlagged);
}

function printSet(r: SetResult): void {
  const a = r.refuse;
  console.log(`\n== ${r.name}: ${r.items} items (${r.planted} planted, ${r.benign} benign); texts sha256 ${r.textsSha256.slice(0, 16)}`);
  console.log('  REFUSE  recall                ', pct(...a.recall));
  console.log('          credentials           ', pct(...a.credentialRecall));
  console.log('          personal identifiers  ', pct(...a.identifierRecall));
  console.log('          false block (benign)  ', pct(...a.falseBlock), JSON.stringify(a.falseBlockKinds));
  console.log('          missed (stored whole) ', JSON.stringify(a.missed));
  printRedact('REDACT/match   ', r.redactMatch);
  printRedact('REDACT/extended', r.redactExtended);
}

function main(argv: string[]): void {
  const sets: SetResult[] = [];
  const texts: TextsResult[] = [];
  let jsonOut: string | undefined;
  let longMemEval: string | undefined;
  let investigation = false;
  let custom = false;
  for (let i = 0; i < argv.length; i++) {
    const [flag, val] = [argv[i], argv[i + 1]];
    if (flag === '--json') { jsonOut = val; i++; continue; }
    if (flag === '--investigation') { investigation = custom = true; continue; }
    if (flag === '--longmemeval') {
      if (!val) throw new Error('--longmemeval needs the path to longmemeval_s.json');
      longMemEval = val;
      investigation = custom = true;
      i++;
      continue;
    }
    if (flag !== '--set' && flag !== '--texts') throw new Error(`unknown argument ${flag}`);
    const eq = val?.indexOf('=') ?? -1;
    if (eq < 1) throw new Error(`${flag} needs name=path`);
    const [name, path] = [val.slice(0, eq), val.slice(eq + 1)];
    custom = true;
    i++;
    if (flag === '--set') sets.push(measureSet(name, readJsonl<PlantedItem>(path).map(it => ({ ...it, secrets: it.secrets ?? [] }))));
    else texts.push(measureTexts(name, readJsonl<{ text: string }>(path).map(r => r.text)));
  }
  const dataset = longMemEval === undefined ? undefined : readLongMemEval(longMemEval);
  if (investigation || !custom) sets.unshift(...investigationSets(dataset));
  if (dataset) texts.unshift(measureNaturalTurns(dataset));
  if (!custom) {
    sets.push(measureSet('mirror:planted', buildPlantedSet()), measureSet('mirror:robustness', buildRobustnessSet()));
  }
  for (const r of sets) printSet(r);
  for (const t of texts) {
    console.log(`\n== ${t.name}: ${t.texts} benign texts`);
    console.log('  REFUSE  false block   ', pct(t.flagged, t.texts), JSON.stringify(t.byRule));
    console.log('  REDACT  false redact  ', pct(t.flagged, t.texts), `; of the flagged texts' ${t.charsReplaced.match[1]} characters: ${t.charsReplaced.match[0]} replaced by match spans, ${t.charsReplaced.extended[0]} by extended spans`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ sets, texts }, null, 2) + '\n');
}

const invokedDirectly = process.argv[1]?.endsWith('secret-guard/measure.ts') === true;
if (invokedDirectly) main(process.argv.slice(2));
