import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildImportPlan, type ImportPlan } from '../../src/importing/plan';
import { applyImportPlan } from '../../src/importing/apply';
import { writeBundle } from '../../src/importing/bundle-write';
import { run as runCli } from '../../src/importing/cli';
import { parseLedgerEvents } from '../../src/memory/lifecycle';
import { BUNDLE_FORMAT, type ImportBundle, type ImportFact, type ImportNote } from '../../src/importing/types';
import { KEY_SHAPES, Rng, password } from '../../scripts/eval/secret-guard/plantedSet';

/**
 * RENOR_SECRET_GUARD on the import path: a supported bulk write into the same canonical memory as `remember`.
 *
 * With the guard on, a note or fact that looks like a secret is left out of the plan, with its reason, and every other
 * note is still imported; a plan that still holds one (built with the guard off, or by another caller) is refused whole
 * before its first directory, file, ledger event or index row. Nothing the guard refuses is stored, and no output (the
 * CLI's, the error's, the log's) repeats it. Planted synthetic secrets only, built at run time from a seed.
 */

const LEDGER = 'System/Memory Events Ledger.md';
const SAVED = process.env.RENOR_SECRET_GUARD;
const tmpDirs: string[] = [];

const mkdir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `import-guard-${tag}-`));
  tmpDirs.push(d);
  return d;
};

const r = new Rng(20261003);
const KEY = KEY_SHAPES.openai_proj(r);
const TOKEN = KEY_SHAPES.github(r);
const STRIPE = KEY_SHAPES.stripe(r);
const WIFI = password(r);
const CARD = '4242 4242 4242 4242';
/** Enough of a secret, from its random end and its start, to find it in anything that holds it. */
const fragments = (secret: string) => [secret.slice(-14), secret.slice(0, 10)].filter(f => f.length >= 8);
const SECRETS = [KEY, TOKEN, STRIPE, WIFI];

/** Every byte under `dir` (the index database included) as one string, to look for a secret in. */
function allBytes(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      parts.push(full); // a file or directory NAME can hold a secret too
      if (e.isDirectory()) walk(full);
      else parts.push(fs.readFileSync(full).toString('latin1'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return parts.join('\n');
}
const files = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).map(String).sort() : []);

function note(rel: string, content: string, extra: Partial<ImportNote> = {}): ImportNote {
  const title = extra.title ?? path.basename(rel, '.md');
  return {
    sourcePath: `/source/${rel}`, relPath: rel, title, kind: null, modifiedAt: '2026-01-01T00:00:00.000Z', frontmatter: {},
    originalContent: content, chunks: [{ headingPath: title, text: content, tokenCount: 12 }], entities: [], ...extra,
  };
}
function fact(subject: string, predicate: string, object: string, extra: Partial<ImportFact> = {}): ImportFact {
  return { subject, predicate, object, scope: 'global', validFrom: '2026-01-01T00:00:00.000Z', sourcePath: '_mcp_', origin: 'note', ...extra };
}
function bundleOf(notes: ImportNote[], facts: ImportFact[] = []): ImportBundle {
  return {
    format: BUNDLE_FORMAT, sourceLabel: 'src', notes, facts,
    stats: { notesAvailable: notes.length, notesSelected: notes.length, notesFilteredOut: 0, notesWithOriginalBytes: notes.length, chunksSelected: notes.length, factsAvailable: facts.length, factsSelected: facts.length },
  };
}
const OPTIONS = { namespace: 'Imported/src', label: 'src', eventSource: 'import:src' };

/** By name, so this file loads and fails on behaviour (not on a missing module) against code that has no guard. */
const isImportRefusal = (e: unknown): e is Error & { skips: { notes: unknown[]; events: unknown[] } } => e instanceof Error && e.name === 'ImportRefusedError';
async function refused(promise: Promise<unknown>): Promise<Error & { skips: { notes: unknown[]; events: unknown[] } }> {
  const outcome = await promise.then(() => null, (e: unknown) => e);
  expect(outcome, 'the import was refused').not.toBeNull();
  expect(isImportRefusal(outcome), `refused as ImportRefusedError, got ${String(outcome)}`).toBe(true);
  return outcome as Error & { skips: { notes: unknown[]; events: unknown[] } };
}

/** A bundle with clean content and, one at a time, a secret in each place an import stores text. */
function mixedBundle(): ImportBundle {
  return bundleOf([
    note('Clean/one.md', '# One\n\nI moved to Lisbon in March.\n'),
    note('Clean/two.md', '# Two\n\nThe standup is at 9:30 on weekdays.\n'),
    note('Keys/in-content.md', `# Deploy\n\nthe staging key is ${KEY}, keep it safe\n`),
    note('Cards/card.md', `# Billing\n\nCharge the renewal to card ${CARD}.\n`),
    note(`Keys/${TOKEN}.md`, '# Misnamed\n\nA note whose file name is itself a token.\n'),
    note('Fields/in-title.md', '# Title\n\nclean body\n', { title: `token ${TOKEN}` }),
    note('Fields/in-frontmatter.md', '# Frontmatter\n\nclean body\n', { frontmatter: { api_key: STRIPE } }),
    note('Fields/in-chunk.md', '# Chunk\n\nclean body\n', { chunks: [{ headingPath: 'Chunk', text: `the live key is ${STRIPE}`, tokenCount: 8 }] }),
    note('Fields/in-entity.md', '# Entity\n\nclean body\n', { entities: [{ type: 'service', canonicalName: TOKEN, aliases: [], confidence: 1 }] }),
  ], [
    fact('Rowan', 'works_at', 'Memory Company'),
    fact('stripe', 'live_key', STRIPE),
    fact('home wifi', 'admin_password', WIFI),
    fact('Rowan', 'lives_in', 'Lisbon', { ledgerSource: KEY }),
  ]);
}

beforeEach(() => {
  process.env.RENOR_SECRET_GUARD = '1';
});
afterEach(() => {
  vi.restoreAllMocks();
  if (SAVED === undefined) delete process.env.RENOR_SECRET_GUARD;
  else process.env.RENOR_SECRET_GUARD = SAVED;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('the plan (guard on): a note or fact that looks like a secret is left out, with the reason', () => {
  it('keeps every clean note and fact and says which others were left out and why, for each place an import stores text', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plan = buildImportPlan(mixedBundle(), OPTIONS);
    expect(plan.notes.map(n => n.relPath)).toEqual(['Imported/src/Clean/one.md', 'Imported/src/Clean/two.md']);
    expect(plan.events.map(e => `${e.subject}/${e.predicate}`)).toEqual(['Rowan/works_at']);

    const skips = plan.skipped.secretGuard!;
    // Each note names the FIRST field the scanner flagged, in the order an import stores them.
    expect(skips.notes.map(s => [s.ref, s.field, s.reason])).toEqual([
      ['Imported/src/Keys/in-content.md', 'content', 'credential'],
      ['Imported/src/Cards/card.md', 'content', 'identifier'],
      [null, 'path', 'credential'], // the file name is itself a token: withheld, not shown
      ['Imported/src/Fields/in-title.md', 'title', 'credential'],
      ['Imported/src/Fields/in-frontmatter.md', 'frontmatter', 'credential'],
      ['Imported/src/Fields/in-chunk.md', 'chunk', 'credential'],
      ['Imported/src/Fields/in-entity.md', 'entity', 'credential'],
    ]);
    expect(skips.events).toHaveLength(3);
    expect(skips.events.every(s => /^mem_[A-Za-z0-9]+$/.test(s.ref ?? ''))).toBe(true);
    expect(skips.events.map(s => s.field).sort()).toEqual(['source', 'subject, predicate and object', 'subject, predicate and object']);

    // The counts describe what the plan now holds.
    expect(plan.counts).toMatchObject({ notesInBundle: 9, selectedNotes: 2, eventsToAppend: 1, notesFromOriginalBytes: 2, notesReconstructed: 0 });

    // Nothing the reasons say repeats a secret, or the flagged path.
    const said = JSON.stringify(plan.skipped);
    for (const secret of SECRETS) for (const f of fragments(secret)) expect(said).not.toContain(f);
    expect(said).not.toContain(CARD);
  });

  it('screens a note\'s kind, a chunk\'s heading, and its entities\' types and aliases, too: in a bundle they are free text that the index stores', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plan = buildImportPlan(bundleOf([
      note('Fields/in-kind.md', '# Kind\n\nclean body\n', { kind: `token ${TOKEN}` }),
      note('Fields/in-type.md', '# Type\n\nclean body\n', { entities: [{ type: `key ${STRIPE}`, canonicalName: 'Acme', aliases: [], confidence: 1 }] }),
      note('Fields/in-alias.md', '# Alias\n\nclean body\n', { entities: [{ type: 'service', canonicalName: 'Acme', aliases: ['acme', TOKEN], confidence: 1 }] }),
      note('Fields/in-heading.md', '# Heading\n\nclean body\n', { chunks: [{ headingPath: `token ${TOKEN}`, text: 'clean body', tokenCount: 4 }] }),
      note('Fields/fine.md', '# Fine\n\nclean body\n', { kind: 'person', entities: [{ type: 'service', canonicalName: 'Acme', aliases: ['acme'], confidence: 1 }] }),
    ]), OPTIONS);
    expect(plan.notes.map(n => n.relPath)).toEqual(['Imported/src/Fields/fine.md']);
    expect(plan.skipped.secretGuard!.notes.map(x => [x.ref, x.field, x.reason])).toEqual([
      ['Imported/src/Fields/in-kind.md', 'kind', 'credential'],
      ['Imported/src/Fields/in-type.md', 'entity', 'credential'],
      ['Imported/src/Fields/in-alias.md', 'entity', 'credential'],
      ['Imported/src/Fields/in-heading.md', 'chunk heading', 'credential'],
    ]);
  });

  it('logs one JSON line per item it leaves out, with the field and the reason and nothing else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildImportPlan(mixedBundle(), OPTIONS);
    expect(warn).toHaveBeenCalledTimes(10);
    for (const call of warn.mock.calls) {
      const line = String(call[0]);
      const parsed = JSON.parse(line);
      expect(Object.keys(parsed).sort()).toEqual(['action', 'event', 'field', 'reason', 'ts']);
      expect(parsed).toMatchObject({ event: 'secret_guard_refusal', action: 'import' });
      for (const secret of SECRETS) for (const f of fragments(secret)) expect(line).not.toContain(f);
    }
  });

  it('is still the same plan for a bundle with nothing in it that looks like a secret', () => {
    const clean = bundleOf([note('A/a.md', '# A\n\nplain\n'), note('B/b.md', '# B\n\nalso plain\n')], [fact('Rowan', 'works_at', 'Memory Company')]);
    const guarded = buildImportPlan(clean, OPTIONS);
    delete process.env.RENOR_SECRET_GUARD;
    const open = buildImportPlan(clean, OPTIONS);
    expect(guarded.skipped.secretGuard).toEqual({ notes: [], events: [] });
    // The only difference is that the guarded plan says it screened.
    expect({ ...guarded, skipped: { ...guarded.skipped, secretGuard: undefined } }).toEqual({ ...open, skipped: { ...open.skipped, secretGuard: undefined } });
  });

  it('with the guard off leaves everything in, and the plan has no trace of the guard', () => {
    delete process.env.RENOR_SECRET_GUARD;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plan: ImportPlan = buildImportPlan(mixedBundle(), OPTIONS);
    expect(plan.notes).toHaveLength(9);
    expect(plan.events).toHaveLength(4);
    expect('secretGuard' in plan.skipped).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('secretGuard');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('apply (guard on): a plan that still holds one is refused whole, before anything is written', () => {
  /** What a caller that built its plan with the guard off, or by hand, would hand to apply. */
  function unscreenedPlan(bundle: ImportBundle): ImportPlan {
    const saved = process.env.RENOR_SECRET_GUARD;
    delete process.env.RENOR_SECRET_GUARD;
    try {
      return buildImportPlan(bundle, OPTIONS);
    } finally {
      process.env.RENOR_SECRET_GUARD = saved;
    }
  }

  it('writes nothing, not even the memory directory, and the error and the log name counts and fields, never text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = mixedBundle();
    const plan = unscreenedPlan(bundle);
    const memoryDir = path.join(mkdir('dest'), 'workspace', 'memory');
    const err = await refused(applyImportPlan(plan, bundle, { memoryDir }));
    expect(err.skips.notes).toHaveLength(7);
    expect(err.skips.events).toHaveLength(3);
    expect(err.message).toMatch(/^import refused: 7 note\(s\) and 3 fact\(s\) in this plan appear to contain a credential or personal identifier/);
    expect(err.message).toContain('nothing was written');
    // it names the first few by path, field and class, and a path that is itself a secret is withheld
    expect(err.message).toContain('Imported/src/Keys/in-content.md (content: credential)');
    expect(err.message).toContain('(path withheld) (path: credential)');
    expect(err.message).toContain('; and 5 more');
    for (const secret of SECRETS) for (const f of fragments(secret)) expect(err.message).not.toContain(f);
    expect(fs.existsSync(memoryDir)).toBe(false);
    expect(fs.existsSync(path.dirname(memoryDir))).toBe(false);
    // one log line for each of the ten items it refused: the action, the field and the reason, and no text
    expect(warn).toHaveBeenCalledTimes(10);
    for (const call of warn.mock.calls) {
      const line = String(call[0]);
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(['action', 'event', 'field', 'reason', 'ts']);
      expect(JSON.parse(line)).toMatchObject({ event: 'secret_guard_refusal', action: 'import' });
      for (const secret of SECRETS) for (const f of fragments(secret)) expect(line).not.toContain(f);
      expect(line).not.toContain(CARD);
    }
  });

  it('refuses a mixed plan whole: the clean notes in it are not written either, and what was already there is untouched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = mixedBundle();
    const plan = unscreenedPlan(bundle);
    const memoryDir = mkdir('dest');
    fs.mkdirSync(path.join(memoryDir, 'Mine'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'Mine', 'existing.md'), '# Mine\n\nmy own note\n');
    const before = files(memoryDir);
    await refused(applyImportPlan(plan, bundle, { memoryDir }));
    expect(files(memoryDir)).toEqual(before);
    expect(fs.existsSync(path.join(memoryDir, 'Imported'))).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, '.memory-index'))).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, LEDGER))).toBe(false);
    expect(fs.readFileSync(path.join(memoryDir, 'Mine', 'existing.md'), 'utf8')).toBe('# Mine\n\nmy own note\n');
  });

  it('refuses on one flagged note alone, with every fact clean', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = bundleOf([note('A/a.md', '# A\n\nplain\n'), note('B/b.md', `# B\n\nthe live key is ${STRIPE}\n`)], [fact('Rowan', 'works_at', 'Memory Company')]);
    const plan = unscreenedPlan(bundle);
    const memoryDir = path.join(mkdir('dest'), 'memory');
    const err = await refused(applyImportPlan(plan, bundle, { memoryDir }));
    expect([err.skips.notes.length, err.skips.events.length]).toEqual([1, 0]);
    expect(fs.existsSync(memoryDir)).toBe(false);
  });

  it('refuses on one flagged fact alone, before the notes are written: the order of the writes is not the guard', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = bundleOf([note('A/a.md', '# A\n\nplain\n')], [fact('stripe', 'live_key', STRIPE)]);
    const plan = unscreenedPlan(bundle);
    const memoryDir = path.join(mkdir('dest'), 'memory');
    await refused(applyImportPlan(plan, bundle, { memoryDir }));
    expect(fs.existsSync(memoryDir)).toBe(false);
  });

  it('applies a plan that holds nothing flagged exactly as before', async () => {
    const bundle = bundleOf([note('A/a.md', '# A\n\nplain\n')], [fact('Rowan', 'works_at', 'Memory Company')]);
    const plan = buildImportPlan(bundle, OPTIONS);
    const memoryDir = mkdir('dest');
    const result = await applyImportPlan(plan, bundle, { memoryDir });
    expect(result).toMatchObject({ notesWritten: 1, eventsAppended: 1 });
    expect(fs.readFileSync(path.join(memoryDir, 'Imported', 'src', 'A', 'a.md'), 'utf8')).toBe('# A\n\nplain\n');
  });

  it('with the guard off, applies the same plan in full, which is what the guard was stopping', async () => {
    delete process.env.RENOR_SECRET_GUARD;
    const bundle = mixedBundle();
    const plan = buildImportPlan(bundle, OPTIONS);
    const memoryDir = mkdir('dest');
    const result = await applyImportPlan(plan, bundle, { memoryDir });
    expect(result.notesWritten).toBe(9);
    expect(allBytes(memoryDir)).toContain(KEY);
  });
});

describe('the operator boundary (guard on): renor-import over a real folder, with every output searched', () => {
  const secretNames = [`${KEY_SHAPES.openai_proj(new Rng(5))}.md`];

  function sourceFolder(): string {
    const src = mkdir('src');
    const put = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), body);
    };
    put('People/Ada.md', '# Ada\n\nAda leads the platform team and prefers short answers.\n');
    put('Projects/Launch.md', '# Launch\n\nThe launch is on the 14th and Rachel owns the checklist.\n');
    put('Ops/keys.md', `# Keys\n\nthe staging key is ${KEY}, keep it somewhere safe\n`);
    put('Billing/card.md', `# Billing\n\nCharge the renewal to card ${CARD}, exp 08/29.\n`);
    put(`Misc/${secretNames[0]}`, '# Misnamed\n\nA note whose file name is itself a key.\n');
    return src;
  }

  /** Run the CLI and return everything it said, on every stream, with its exit code. */
  async function cli(args: string[]): Promise<{ code: number; said: string }> {
    const said: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
    const code = await runCli(args);
    return { code, said: said.join('\n') };
  }
  const noSecretIn = (text: string) => {
    for (const secret of [KEY, CARD, secretNames[0].replace(/\.md$/, '')]) for (const f of fragments(secret)) expect(text).not.toContain(f);
  };

  it('imports the clean notes, lists the others with a reason, exits 3, and leaves no trace of a refused note anywhere', async () => {
    const src = sourceFolder();
    const dest = mkdir('dest');
    const { code, said } = await cli(['--from', `markdown:${src}`, '--to', dest, '--apply', '--namespace', 'Imported/src']);
    expect(code).toBe(3); // like a conflict: something asked for was not imported, and it says so
    expect(said).toMatch(/secret guard\s+: 3 note\(s\) and 0 fact\(s\) not imported/);
    expect(said).toContain('every other note still is');
    expect(said).toContain('Imported/src/Ops/keys.md (content: credential)');
    expect(said).toContain('Imported/src/Billing/card.md (content: identifier)');
    expect(said).toContain('(path withheld) (path: credential)');
    noSecretIn(said);

    // On disk: the two clean notes, byte for byte, and nothing else of the import.
    expect(files(path.join(dest, 'Imported')).filter(f => f.endsWith('.md'))).toEqual(['src/People/Ada.md', 'src/Projects/Launch.md']);
    expect(fs.readFileSync(path.join(dest, 'Imported', 'src', 'People', 'Ada.md'), 'utf8')).toBe(fs.readFileSync(path.join(src, 'People', 'Ada.md'), 'utf8'));
    expect(fs.existsSync(path.join(dest, 'Imported', 'src', 'Ops'))).toBe(false); // no directory made for a refused note
    expect(fs.existsSync(path.join(dest, 'Imported', 'src', 'Billing'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'Imported', 'src', 'Misc'))).toBe(false);
    noSecretIn(allBytes(dest)); // file bytes, file and directory names, the ledger, the index database

    // In the index: rows for the clean notes only.
    const db = new Database(path.join(dest, '.memory-index', 'index.db'), { readonly: true });
    const rows = db.prepare("SELECT path FROM notes WHERE path != '_mcp_' ORDER BY path").all() as Array<{ path: string }>;
    expect(rows.map(x => path.relative(dest, x.path).split(path.sep).join('/'))).toEqual(['Imported/src/People/Ada.md', 'Imported/src/Projects/Launch.md']);
    const chunkText = (db.prepare('SELECT group_concat(text, char(10)) AS t FROM chunks').get() as { t: string }).t;
    noSecretIn(chunkText);
    db.close();
  });

  it('shows the same reasons in a dry run and writes nothing', async () => {
    const src = sourceFolder();
    const dest = path.join(mkdir('dest'), 'never-created');
    const { code, said } = await cli(['--from', `markdown:${src}`, '--to', dest, '--namespace', 'Imported/src']);
    expect(code).toBe(0);
    expect(said).toContain('PLAN (dry run');
    expect(said).toMatch(/secret guard\s+: 3 note\(s\) and 0 fact\(s\) not imported/);
    expect(said).toContain('Imported/src/Ops/keys.md (content: credential)');
    noSecretIn(said);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('puts the reasons in the machine-readable summary too', async () => {
    const src = sourceFolder();
    const dest = mkdir('dest');
    const { code, said } = await cli(['--from', `markdown:${src}`, '--to', dest, '--apply', '--namespace', 'Imported/src', '--json']);
    expect(code).toBe(3);
    // The refusal log lines come first on the same stream; the summary is the object that opens with "mode".
    const summary = JSON.parse(said.slice(said.indexOf('{\n  "mode"')));
    // In the order the source lists its files: Billing, Misc (the file named like a key), Ops.
    expect(summary.skipped.secretGuard.notes).toEqual([
      { ref: 'Imported/src/Billing/card.md', field: 'content', reason: 'identifier' },
      { ref: null, field: 'path', reason: 'credential' },
      { ref: 'Imported/src/Ops/keys.md', field: 'content', reason: 'credential' },
    ]);
    expect(summary.skipped.secretGuard.events).toEqual([]);
    noSecretIn(said);
  });

  it('carries and screens facts too: a bundle with a flagged fact imports every other fact and note', async () => {
    const bundleFile = path.join(mkdir('bundle'), 'slice.jsonl');
    writeBundle(bundleOf(
      [note('Clean/one.md', '# One\n\nplain\n')],
      [fact('Rowan', 'works_at', 'Memory Company'), fact('stripe', 'live_key', STRIPE)],
    ), bundleFile);
    const dest = mkdir('dest');
    const { code, said } = await cli(['--from', `bundle:${bundleFile}`, '--to', dest, '--apply', '--namespace', 'Imported/src']);
    expect(code).toBe(3);
    expect(said).toMatch(/secret guard\s+: 0 note\(s\) and 1 fact\(s\) not imported/);
    expect(said).toMatch(/! fact mem_[A-Za-z0-9]+ \(subject, predicate and object: credential\)/);
    for (const f of fragments(STRIPE)) expect(said).not.toContain(f);
    const events = parseLedgerEvents(fs.readFileSync(path.join(dest, LEDGER), 'utf8'));
    expect(events.map(e => `${e.subject}/${e.predicate}`)).toEqual(['Rowan/works_at']);
    for (const f of fragments(STRIPE)) expect(allBytes(dest)).not.toContain(f);
  });

  it('with the guard off, imports all of it and says nothing about the guard', async () => {
    delete process.env.RENOR_SECRET_GUARD;
    const src = sourceFolder();
    const dest = mkdir('dest');
    const { code, said } = await cli(['--from', `markdown:${src}`, '--to', dest, '--apply', '--namespace', 'Imported/src']);
    expect(code).toBe(0);
    expect(said).not.toContain('secret guard');
    expect(files(path.join(dest, 'Imported')).filter(f => f.endsWith('.md'))).toHaveLength(5);
    expect(allBytes(dest)).toContain(KEY);
  });
});
