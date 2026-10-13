import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';
import type { EvalCase } from '../../src/eval/scoring';
import { chunkNote } from '../../src/indexer/chunker';
import { parseNote } from '../../src/indexer/parser';
import { encodeTokens } from '../../src/indexer/tokenizer';
import { jsonl } from './renorbench-common';

/**
 * RenorBench "documents": the fixture and the cases, written by this script and committed (fixtures/eval/renorbench-docs/,
 * docs/evals/renorbench-docs.dev.jsonl). Nothing here reads a clock, the environment or a model: every choice is a table
 * below or a hash of a fixed key, so two runs write the same bytes (tests/eval/renorbench-docs.test.ts regenerates it and
 * compares). Every person, place, code and number is invented.
 *
 * Why a third fixture. v1 is 30 short notes and v2 is chats and logs, so neither can see what a change does to a vault of
 * DOCUMENTS: handbook-style notes whose sections have unique headings, and so are whole-section statements the session
 * expansion may add (a chat's turns share headings, a log's entries share a day, neither reaches the same sizes). A flat
 * 100-token cap on the expansion's statements removed 186 of the 309 answer-bearing statements it delivered on a vault of
 * documents, and passed every gate, because no gated number is made of a document. The measurement, the cap and the design of
 * this arm are in the record that named it (docs/evals/results/RENORBENCH-DOCS-ARM-20261007.md).
 *
 * The vault: 10 topics of a fictional freight depot, each with four notes (a runbook, a policy, weekly meeting notes and a
 * project plan), 40 notes in all, a few hundred sections. Every section is `## <heading>`, the headings of a note are
 * unique, and the sizes of whole sections follow the distribution measured on a real document vault (21.6% up to 60
 * tokens, 14.5% 61-100, 19.3% 101-150, 15.0% 151-200, 29.2% 201-400). Notes of a topic share its vocabulary, so a question
 * about one note also finds its three siblings: the window (the tool's top_k of 20) holds some of the note and rarely all of it.
 *
 * The cases: each note has ONE probed section (a fact with a made-up code, its needle, which occurs nowhere else in the
 * vault), and the five size strata (20-60, 61-100, 101-150, 151-200, 201-400 tokens) take eight probed sections each. Three
 * questions per probed section, none holding its needle:
 *
 *   parent    the note's title: the way a user names a document
 *   neighbor  the opening of the section just before the probed one: the neighbouring topic, with the detail one section away
 *   direct    the opening of the probed section itself, cut before its needle (the control): retrieval finds the statement
 *             on its own, so a limit on the expansion must change nothing
 *
 * 120 cases. parent and neighbor are `adjacent` cases: the probed section reaches the reply when the expansion adds it, or by
 * luck of the window; direct reaches it every time. The category of an adjacent case is the size band of its section
 * (`adjacent-le100`, `adjacent-101-200`, `adjacent-201-400`), and a direct case is `direct`: the product arm scores each by
 * whether the probed section is in the reply of `search_memory` and of `get_context` at 800 tokens.
 *
 * What this is not. It is a tripwire built for the free hash embedder, not a measurement of how well the product remembers:
 * the prose is formulaic on purpose, and the hash embedder is lexical. What the cases keep is the structure the expansion needs:
 * a document whose short sections the window does not hold. A real embedder ranks differently and a real vault differs.
 */

const SEED = 'renorbench-docs';

function index(key: string, length: number): number {
  return crypto.createHash('sha256').update(`${SEED}\0${key}`).digest().readUInt32BE(0) % length;
}

function pick<T>(key: string, values: readonly T[]): T {
  return values[index(key, values.length)];
}

/** The values in an order fixed by the key: a deterministic shuffle. */
function shuffled<T>(key: string, values: readonly T[]): T[] {
  return values
    .map((value, i) => ({ value, order: crypto.createHash('sha256').update(`${SEED}\0${key}\0${i}`).digest().readUInt32BE(0) }))
    .sort((a, b) => a.order - b.order)
    .map(entry => entry.value);
}

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------------------

interface Topic {
  key: string;
  /** What the notes of the topic are about; part of every title. */
  title: string;
  /** Twelve things the notes talk about. */
  things: string[];
}

const TOPICS: Topic[] = [
  { key: 'dock-scanners', title: 'Dock Scanner', things: ['handheld unit', 'barcode gun', 'charging cradle', 'firmware build', 'scan queue', 'laser window', 'wireless mesh', 'battery pack', 'label reader', 'sync window', 'docking bay', 'scan batch'] },
  { key: 'cold-chain', title: 'Cold Chain Trailer', things: ['reefer unit', 'setpoint', 'door seal', 'temperature logger', 'probe cable', 'pre-cool cycle', 'defrost cycle', 'fuel level', 'compressor alarm', 'load manifest', 'thermal blanket', 'cargo sensor'] },
  { key: 'returns', title: 'Returns Desk', things: ['return slip', 'restock bin', 'grading label', 'refund ticket', 'quarantine shelf', 'damage photo', 'supplier credit', 'inspection tray', 'repack station', 'disposal tag', 'serial scan', 'claim form'] },
  { key: 'pallet-labels', title: 'Pallet Label', things: ['label printer', 'ribbon roll', 'serial range', 'pallet tag', 'wrap station', 'label stock', 'print head', 'template file', 'reprint queue', 'adhesive grade', 'tag audit', 'barcode zone'] },
  { key: 'driver-rosters', title: 'Driver Roster', things: ['shift bid', 'rest period', 'route card', 'standby list', 'swap request', 'licence check', 'duty log', 'depot board', 'overtime cap', 'relief driver', 'handover sheet', 'absence code'] },
  { key: 'forklifts', title: 'Forklift Fleet', things: ['mast chain', 'tyre set', 'battery bank', 'charge bay', 'inspection card', 'operator badge', 'load chart', 'horn test', 'service tag', 'hydraulic hose', 'speed limiter', 'key cabinet'] },
  { key: 'customs', title: 'Customs File', things: ['tariff line', 'entry form', 'broker', 'bond number', 'duty deferral', 'commercial invoice', 'origin certificate', 'hold notice', 'release code', 'inspection slot', 'bonded cage', 'filing deadline'] },
  { key: 'cycle-counts', title: 'Cycle Count', things: ['count sheet', 'variance band', 'location tag', 'freeze window', 'recount ticket', 'aisle sweep', 'tolerance limit', 'adjustment note', 'blind count', 'pick face', 'stock ledger', 'audit sample'] },
  { key: 'carrier-invoices', title: 'Carrier Invoice', things: ['rate card', 'fuel surcharge', 'accessorial charge', 'dispute window', 'remittance file', 'proof of delivery', 'weight break', 'invoice batch', 'credit memo', 'lane code', 'accrual report', 'payment run'] },
  { key: 'yard-gate', title: 'Yard Gate', things: ['gate pass', 'trailer pool', 'appointment slot', 'seal check', 'kiosk screen', 'spotter', 'dwell clock', 'barrier arm', 'plate reader', 'queue lane', 'weigh bridge', 'visitor log'] },
];

interface Kind {
  key: string;
  /** Title suffix, so that a title is `<topic> <suffix>` and unique. */
  suffix: string;
  headings: string[];
}

const KINDS: Kind[] = [
  { key: 'runbook', suffix: 'Runbook', headings: ['Purpose', 'Scope', 'Alarm thresholds', 'First response', 'Escalation contacts', 'Rollback steps', 'Shift handover', 'Evidence to keep', 'Known false alarms', 'After the incident'] },
  { key: 'policy', suffix: 'Policy', headings: ['Intent', 'Who this applies to', 'Definitions', 'Required checks', 'Exceptions', 'Approvals', 'Record keeping', 'Audit cadence', 'Breaches', 'Review date'] },
  { key: 'meeting', suffix: 'Weekly Notes', headings: ['Attendees', 'Agenda', 'Decisions', 'Open questions', 'Action items', 'Risks raised', 'Metrics reviewed', 'Deferred items', 'Next meeting', 'Parking lot'] },
  { key: 'project', suffix: 'Project Plan', headings: ['Goal', 'Background', 'Milestones', 'Owners', 'Dependencies', 'Budget notes', 'Risks', 'Rollout', 'Success measures', 'Out of scope'] },
];

const ACTORS = [
  'Odile Varga', 'Henrik Soto', 'Priyanka Daalen', 'Tomasz Okeke', 'Marit Quell', 'Ignacio Brandt', 'Wenna Lacroix', 'Dario Feng',
  'the shift lead', 'the duty planner', 'the site supervisor', 'the night coordinator', 'the depot manager', 'the yard marshal',
];
const PLACES = ['Bay 4', 'the Harbour Road depot', 'the Fenmoor site', 'Kessel Yard', 'the east annex', 'Gate 2', 'the Tern Quay hall', 'the Marlow cross-dock'];
const TIMES = ['within 40 minutes', 'before 06:30', 'every second Tuesday', 'by the end of the shift', 'on the first working day of the month', 'within 2 hours', 'before the 14:00 cut-off', 'each Friday'];
const COUNTS = ['12', '3', '40', '6', '20', '8', '15', '30'];

/** Sentence frames: {A} actor, {N} and {M} two things of the topic, {P} place, {T} time, {C} count. */
const FRAMES = [
  '{A} checks the {N} at {P} and records the result in the {M} log {T}.',
  'If the {N} is not confirmed {T}, {A} raises it with the owner of the {M}.',
  'Keep the {N} apart from the {M}; mixing them caused {C} repeat visits to {P}.',
  'The {N} is reviewed {T}, and {A} signs off any change to the {M}.',
  'A {N} older than {C} days is treated as stale and replaced at {P}.',
  '{A} owns the {M} and decides when the {N} can be released.',
  'Anything unusual about the {N} goes to {A}, with a note of the {M}.',
  'At {P} the {N} and the {M} are handled by the same crew, {T}.',
  'Do not reuse a {N} after the first fault; log the {M} instead.',
  'The {M} limit is {C} per shift at {P}, as agreed with {A}.',
  'When the {N} changes, {A} updates the {M} and tells {P} {T}.',
  'The crew keeps {C} spare units of the {N} beside the {M}.',
  '{A} walks {P} {T} to confirm the {N} matches the {M}.',
  'Never close a {N} without a matching {M}; the audit asks for both.',
  'Short gaps in the {N} are normal at {P}, but {C} in a row go to {A}.',
  'The {M} is photographed first, then the {N}, so the record shows the order.',
  'Any {N} moved to {P} is entered in the {M} ledger {T}.',
  'Questions about the {N} go to {A}; questions about the {M} go to the front desk.',
];

/** Fact sentences, the ones that carry a needle: {K} is the code. */
const FACTS = [
  'The override code for the {N} at {P} is {K}.',
  'Quote reference {K} when you ask {A} to release the {M}.',
  '{A} confirmed the {N} change under reference {K}.',
  'The standby key for the {M} is filed under {K}.',
  'Ticket {K} covers the {N} swap at {P}.',
];

const INTROS = [
  'This part covers the {N} and how {A} handles it at {P}.',
  'Read this before touching the {N} or the {M}.',
  'The {N} is the part of the work that {A} checks most often.',
  'These notes describe the {N} as it is used at {P}.',
];

function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{([A-Z])\}/g, (_, letter: string) => {
    const value = slots[letter];
    if (value === undefined) throw new Error(`no slot ${letter} in ${template}`);
    return value;
  });
}

function slotsFor(key: string, topic: Topic): Record<string, string> {
  const first = index(`${key}\0N`, topic.things.length);
  let second = index(`${key}\0M`, topic.things.length);
  if (second === first) second = (second + 1) % topic.things.length;
  return {
    A: pick(`${key}\0A`, ACTORS),
    N: topic.things[first],
    M: topic.things[second],
    P: pick(`${key}\0P`, PLACES),
    T: pick(`${key}\0T`, TIMES),
    C: pick(`${key}\0C`, COUNTS),
  };
}

function sentence(key: string, topic: Topic): string {
  const text = fill(pick(`${key}\0frame`, FRAMES), slotsFor(key, topic));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------------------------

/** Size strata of a whole section, in chunk tokens (the heading line counts). */
const STRATA = [
  { name: 's1_le60', lo: 20, hi: 60, band: 'adjacent-le100' },
  { name: 's2_61_100', lo: 61, hi: 100, band: 'adjacent-le100' },
  { name: 's3_101_150', lo: 101, hi: 150, band: 'adjacent-101-200' },
  { name: 's4_151_200', lo: 151, hi: 200, band: 'adjacent-101-200' },
  { name: 's5_201_400', lo: 201, hi: 390, band: 'adjacent-201-400' },
] as const;

/** Shares of whole sections by stratum, measured on a real document vault (2,492 sections). Cumulative bounds. */
const SIZE_SHARE = [0.216, 0.361, 0.554, 0.704, 1];

function stratumOfDraw(key: string): number {
  const u = index(key, 1_000_000) / 1_000_000;
  const at = SIZE_SHARE.findIndex(bound => u < bound);
  return at < 0 ? STRATA.length - 1 : at;
}

const tokensOf = (text: string): number => encodeTokens(text.trim());

function renderSection(heading: string, paragraphs: string[]): string {
  return `## ${heading}\n\n${paragraphs.join('\n\n')}\n`;
}

/** Sentences are grouped into short paragraphs, so a long section reads as one. */
function paragraphsOf(sentences: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += 3) out.push(sentences.slice(i, i + 3).join(' '));
  return out;
}

interface Section {
  heading: string;
  text: string;
  tokens: number;
  stratum: number;
  /** The needle of a probed section. */
  needle?: string;
  /** The question of `direct` style: the section's opening, cut before its needle. */
  directQuery?: string;
}

/**
 * One section of `stratum`, filled to a size inside it: `lead` sentences first (an intro, a fact), then frames until the
 * size drawn for the section is reached. A draw that cannot land inside the band is redrawn with another salt.
 */
function buildSection(key: string, topic: Topic, heading: string, stratumIndex: number, lead: string[]): Section {
  const stratum = STRATA[stratumIndex];
  for (let attempt = 0; attempt < 40; attempt++) {
    const salt = `${key}\0${attempt}`;
    const target = stratum.lo + 6 + index(`${salt}\0target`, Math.max(1, stratum.hi - stratum.lo - 12));
    const sentences = [...lead];
    for (let i = 0; tokensOf(renderSection(heading, paragraphsOf(sentences))) < target && i < 80; i++) {
      sentences.push(sentence(`${salt}\0s${i}`, topic));
    }
    const text = renderSection(heading, paragraphsOf(sentences));
    const tokens = tokensOf(text);
    if (tokens >= stratum.lo && tokens <= stratum.hi) return { heading, text, tokens, stratum: stratumIndex };
  }
  throw new Error(`cannot size section ${key} into ${stratum.name}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------------------------

interface BuiltNote {
  notePath: string;
  title: string;
  text: string;
  ageDays: number;
  sections: Section[];
  /** Position of the probed section among `sections`. */
  probed: number;
}

const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

function codeFor(i: number, taken: Set<string>): string {
  for (let salt = 0; ; salt++) {
    const h = crypto.createHash('sha256').update(`${SEED}\0code\0${i}\0${salt}`).digest();
    const code = `${CODE_LETTERS[h[0] % CODE_LETTERS.length]}${CODE_LETTERS[h[1] % CODE_LETTERS.length]}${CODE_LETTERS[h[2] % CODE_LETTERS.length]}${String(h.readUInt16BE(3) % 9000 + 1000)}`;
    if (!taken.has(code)) {
      taken.add(code);
      return code;
    }
  }
}

/** The words of a text, as the cases check a query against a needle. */
const WORD = /[\p{L}\p{N}_]+/gu;
const wordsOf = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

/** Visible words of a section's opening: Markdown markers dropped, at most `chars` characters, cut at a word. */
function opening(text: string, chars: number): string {
  const plain = text.replace(/^#{1,6}\s+/gm, '').replace(/[`*_>|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length <= chars) return plain;
  const cut = plain.slice(0, chars);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trim();
}

function buildNote(noteIndex: number, taken: Set<string>): BuiltNote {
  const topic = TOPICS[Math.floor(noteIndex / KINDS.length)];
  const kind = KINDS[noteIndex % KINDS.length];
  const key = `${topic.key}/${kind.key}`;
  const title = `${topic.title} ${kind.suffix}`;
  const count = 6 + index(`${key}\0count`, 4); // 6 to 9 sections
  const headings = shuffled(`${key}\0headings`, kind.headings).slice(0, count);
  // The probed section is never the first: it needs a section before it to be a neighbour.
  const probed = 1 + index(`${key}\0probed`, count - 1);
  const probedStratum = noteIndex % STRATA.length;
  const code = codeFor(noteIndex, taken);

  const sections = headings.map((heading, at): Section => {
    const sectionKey = `${key}\0${heading}`;
    if (at !== probed) return buildSection(sectionKey, topic, heading, stratumOfDraw(`${sectionKey}\0stratum`), []);
    const slots = { ...slotsFor(`${sectionKey}\0fact`, topic), K: code };
    const intro = fill(pick(`${sectionKey}\0intro`, INTROS), slots);
    const fact = fill(pick(`${sectionKey}\0factframe`, FACTS), slots);
    // The fact comes after some ordinary sentences, so that the question of `direct` style (everything before the needle)
    // is long enough to find its own section; the smallest sections have room for the intro and the fact only.
    const before = Array.from({ length: Math.min(2, probedStratum) }, (_, i) => sentence(`${sectionKey}\0lead${i}`, topic));
    const section = buildSection(sectionKey, topic, heading, probedStratum, [intro, ...before, fact]);
    const body = section.text.replace(/^## [^\n]*\n\n/, '');
    const at2 = body.indexOf(code);
    return { ...section, needle: code, directQuery: opening(body.slice(0, at2), 220) };
  });

  const text = `# ${title}\n\n${sections.map(section => section.text).join('\n')}`;
  return {
    notePath: `${topic.key}/${kind.key}.md`,
    title,
    text,
    ageDays: 60 + (noteIndex * 7) % 300,
    sections,
    probed,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The whole benchmark
// ---------------------------------------------------------------------------------------------------------------

export interface RenorBenchDocs {
  /** Vault-relative path -> note text. */
  notes: Map<string, string>;
  /** fixture.json, as written. */
  fixtureJson: string;
  /** The cases, one JSON object a line, as written. */
  casesJsonl: string;
  cases: EvalCase[];
}

export function buildRenorBenchDocs(): RenorBenchDocs {
  const taken = new Set<string>();
  const built = Array.from({ length: TOPICS.length * KINDS.length }, (_, i) => buildNote(i, taken));

  const notes = new Map<string, string>();
  const cases: EvalCase[] = [];
  built.forEach((note, noteIndex) => {
    if (notes.has(note.notePath)) throw new Error(`two notes at ${note.notePath}`);
    notes.set(note.notePath, note.text);
    const probed = note.sections[note.probed];
    const before = note.sections[note.probed - 1];
    const band = STRATA[probed.stratum].band;
    const number = String(noteIndex + 1).padStart(2, '0');
    const target = [{ match: probed.needle!, notePath: note.notePath }];
    const common = { relevant: target, expectedAnswer: null, split: 'dev' as const };
    cases.push(
      { id: `doc-${number}-parent`, category: band, query: note.title, ...common, notes: `${probed.tokens} tokens, "${probed.heading}"` },
      { id: `doc-${number}-neighbor`, category: band, query: opening(before.text, 300), ...common, notes: `${probed.tokens} tokens, "${probed.heading}"` },
      { id: `doc-${number}-direct`, category: 'direct', query: probed.directQuery!, ...common, notes: `${probed.tokens} tokens, "${probed.heading}"` },
    );
  });

  const ids = new Set<string>();
  for (const test of cases) {
    if (ids.has(test.id)) throw new Error(`duplicate case id ${test.id}`);
    ids.add(test.id);
    for (const target of test.relevant) {
      if (wordsOf(test.query).includes(target.match.toLowerCase())) throw new Error(`${test.id}: the question holds its own needle`);
    }
    if (test.query.length < 8) throw new Error(`${test.id}: the question is too short to ask anything: ${test.query}`);
  }
  // A needle that occurs twice would let another chunk answer the case: the evidence of a case is exactly one place.
  const everything = [...notes.values()].join('\n').toLowerCase();
  for (const test of cases) {
    const needle = test.relevant[0].match.toLowerCase();
    const count = everything.split(needle).length - 1;
    if (count !== 1) throw new Error(`${test.id}: the needle "${needle}" occurs ${count} times in the vault, not once`);
  }
  // What the cases assume of the chunker, checked on the chunker itself: the probed section is a whole-section chunk (no
  // other chunk of its note shares its heading path) of the size its stratum says, and so is the section before it.
  for (const note of built) {
    const chunks = chunkNote(parseNote(note.notePath, note.text));
    const heading = (section: Section): string => `${note.title} > ${section.heading}`;
    if (new Set(note.sections.map(section => section.heading)).size !== note.sections.length) throw new Error(`${note.notePath}: a heading repeats`);
    for (const section of note.sections) {
      const own = chunks.filter(chunk => chunk.headingPath === heading(section));
      if (own.length !== 1 || own[0].tokenCount !== section.tokens) throw new Error(`${note.notePath} "${section.heading}": the chunker does not cut it as one section of ${section.tokens} tokens`);
    }
  }

  const relativeMtimeDays: Record<string, number> = {};
  for (const note of built) relativeMtimeDays[note.notePath] = note.ageDays;
  const sorted = Object.fromEntries(Object.entries(relativeMtimeDays).sort(([a], [b]) => (a < b ? -1 : 1)));
  const fixtureJson = `${JSON.stringify({
    version: 1,
    description: 'RenorBench documents fixture. Forty handbook-style notes (runbooks, policies, weekly notes and project plans of ten topics at a fictional freight depot) with unique section headings, built to ask what a change does to the short sections of a document; all identities, codes and numbers are fictional. Written by scripts/eval/generate-renorbench-docs.ts.',
    relativeMtimeDays: sorted,
  }, null, 2)}\n`;
  return { notes, fixtureJson, casesJsonl: jsonl(cases), cases };
}

// ---------------------------------------------------------------------------------------------------------------
// Command line: write the fixture and the cases where they are committed (or elsewhere, for a look)
// ---------------------------------------------------------------------------------------------------------------

export const DOCS_FIXTURE_DIR = 'fixtures/eval/renorbench-docs';
export const DOCS_CASES_PATH = 'docs/evals/renorbench-docs.dev.jsonl';

function writeBenchmark(built: RenorBenchDocs, fixtureDir: string, casesPath: string): void {
  fs.rmSync(path.join(fixtureDir, 'vault'), { recursive: true, force: true });
  for (const [notePath, text] of built.notes) {
    const target = path.join(fixtureDir, 'vault', notePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
  }
  fs.writeFileSync(path.join(fixtureDir, 'fixture.json'), built.fixtureJson, 'utf8');
  fs.mkdirSync(path.dirname(casesPath), { recursive: true });
  fs.writeFileSync(casesPath, built.casesJsonl, 'utf8');
}

// Run as a script, not when a test imports `buildRenorBenchDocs`.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const program = new Command()
    .name('generate-renorbench-docs')
    .description('Write the RenorBench documents fixture and cases (deterministic: no seed, clock, environment or model)')
    .option('--write', `replace the committed ${DOCS_FIXTURE_DIR} and ${DOCS_CASES_PATH}`)
    .option('--output <dir>', 'write fixture.json, vault/ and cases.jsonl here instead (the directory must be new)')
    .parse(process.argv);
  const opts = program.opts<{ write?: boolean; output?: string }>();
  if (Boolean(opts.write) === Boolean(opts.output)) throw new Error('Specify exactly one of --write or --output <dir>');
  const built = buildRenorBenchDocs();
  if (opts.write) {
    writeBenchmark(built, path.resolve(DOCS_FIXTURE_DIR), path.resolve(DOCS_CASES_PATH));
  } else {
    const output = path.resolve(opts.output!);
    fs.mkdirSync(output, { mode: 0o700 });
    writeBenchmark(built, output, path.join(output, 'cases.jsonl'));
  }
  const categories = new Map<string, number>();
  for (const test of built.cases) categories.set(test.category, (categories.get(test.category) ?? 0) + 1);
  console.log(JSON.stringify({ notes: built.notes.size, cases: built.cases.length, categories: Object.fromEntries(categories) }, null, 2));
}
