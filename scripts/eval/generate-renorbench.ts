import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Command } from 'commander';
import { claimDirectory } from '../../src/eval/artifacts';

const NAMES = ['Ava Morgan','Noah Silva','Maya Chen','Leo Fischer','Sofia Rossi','Elias Novak','Nora Haddad','Mateo Costa','Iris Park','Theo Martin','Lina Berg','Owen Reed'];
const DRINKS = ['passion fruit juice','mango juice','green tea','sparkling water','orange juice','iced coffee','lemonade','apple juice','black tea','coconut water','chamomile tea','grape juice'];
const CITIES = ['Seattle','Boston','Lisbon','Helsinki','Zurich','Montreal','Austin','Tallinn','Copenhagen','Vienna','Dublin','Singapore'];
const INSTRUMENTS = ['cello','violin','piano','flute','clarinet','guitar','trumpet','viola','saxophone','harp','drums','bass'];
const PROJECTS = ['Atlas','Beacon','Cedar','Drift','Ember','Fjord','Grove','Harbor','Ion','Juniper','Kite','Lumen'];

function index(seed: string, key: string, length: number): number {
  const digest = crypto.createHash('sha256').update(`${seed}\0${key}`).digest();
  return digest.readUInt32BE(0) % length;
}

function pick<T>(values: T[], seed: string, key: string, forbidden: T[] = []): T {
  const available = values.filter(value => !forbidden.includes(value));
  if (!available.length) throw new Error(`No distinct values left for ${key}`);
  return available[index(seed, key, available.length)];
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function oneOf(seed: string, key: string, variants: string[]): string {
  return variants[index(seed, key, variants.length)];
}

function jsonl(rows: unknown[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

async function main(): Promise<void> {
  const program = new Command()
    .name('generate-renorbench')
    .option('--seed <secret>', 'review/dev seed only; appears in process arguments')
    .option('--seed-file <path>', 'owner-only UTF-8 seed file; raw seed never enters argv')
    .requiredOption('--output <path>', 'output directory')
    .option('--profiles <n>', 'number of fictional profiles', '6')
    .parse(process.argv);

  const opts = program.opts<{ seed?: string; seedFile?: string; output: string; profiles: string }>();
  if (Boolean(opts.seed) === Boolean(opts.seedFile)) throw new Error('Specify exactly one of --seed-file or --seed');
  const seed = opts.seedFile ? (await fsp.readFile(opts.seedFile, 'utf8')).trim() : opts.seed!;
  const profileCount = Number(opts.profiles);
  if (!Number.isInteger(profileCount) || profileCount < 1 || profileCount > NAMES.length) {
    throw new Error('--profiles must be an integer between 1 and 12');
  }
  if (seed.length < 8) throw new Error('--seed must contain at least 8 characters');

  const output = path.resolve(opts.output);
  const vault = path.join(output, 'vault');
  claimDirectory(output);
  await fsp.mkdir(vault, { recursive: true });

  const mtimes: Record<string, number> = {};
  const cases: unknown[] = [];
  const manifestProfiles: Array<Record<string, unknown>> = [];

  for (let i = 0; i < profileCount; i++) {
    const profileSeed = `${seed}:profile:${i}`;
    const name = pick(NAMES, profileSeed, 'name', manifestProfiles.map(p => p.name as string));
    const id = slug(name);
    const currentDrink = pick(DRINKS, profileSeed, 'currentDrink');
    const previousDrink = pick(DRINKS, profileSeed, 'previousDrink', [currentDrink]);
    const currentCity = pick(CITIES, profileSeed, 'currentCity');
    const previousCity = pick(CITIES, profileSeed, 'previousCity', [currentCity]);
    const instrument = pick(INSTRUMENTS, profileSeed, 'instrument');
    const project = pick(PROJECTS, profileSeed, 'project');
    const distractorDrink = pick(DRINKS, profileSeed, 'distractorDrink', [currentDrink, previousDrink]);
    const distractorCity = pick(CITIES, profileSeed, 'distractorCity', [currentCity, previousCity]);
    const distractorInstrument = pick(INSTRUMENTS, profileSeed, 'distractorInstrument', [instrument]);
    const distractorProject = pick(PROJECTS, profileSeed, 'distractorProject', [project]);

    const currentRel = `People/${id}-current.md`;
    const historyRel = `History/${id}-history.md`;
    const noiseRel = `Noise/${id}-noise.md`;
    await fsp.mkdir(path.join(vault, 'People'), { recursive: true });
    await fsp.mkdir(path.join(vault, 'History'), { recursive: true });
    await fsp.mkdir(path.join(vault, 'Noise'), { recursive: true });

    await fsp.writeFile(path.join(vault, currentRel), `---\nkind: person\naliases: [${name}]\n---\n# ${name}\n\n## Current state\n\n${name}'s current favorite drink is ${currentDrink}.\n\n${name} now lives in ${currentCity}.\n\n${name} is learning ${instrument}.\n\n${name} is currently building a project called ${project}.\n`, 'utf8');
    await fsp.writeFile(path.join(vault, historyRel), `---\nkind: history\n---\n# ${name} — previous state\n\nBefore changing preferences, ${name}'s favorite drink was ${previousDrink}.\n\nBefore moving to ${currentCity}, ${name} lived in ${previousCity}.\n\nThese are historical facts and should remain retrievable when the question explicitly asks about the past.\n`, 'utf8');
    await fsp.writeFile(path.join(vault, noiseRel), `---\nkind: note\n---\n# Adjacent notes about ${name}\n\n${name} saw ${distractorDrink} on a cafe menu but did not say it was a favorite.\n\n${name} compared travel costs for ${distractorCity} for a friend; this did not describe where ${name} lives.\n\n${name} attended a concert featuring ${distractorInstrument}; this is not the instrument ${name} is learning.\n\n${name} read about a software project called ${distractorProject}; it is not ${name}'s own current project.\n\n${name} read a general article about passports and identity documents. The note contains no passport number for ${name}.\n`, 'utf8');

    mtimes[currentRel] = 0;
    mtimes[historyRel] = 365 + i;
    mtimes[noiseRel] = 7 + i;

    const q = (suffix: string, category: string, query: string, relevant: unknown[], expectedAnswer: string | null, shouldAbstain = false) => {
      cases.push({
        id: `${id}-${suffix}`,
        category,
        query,
        relevant,
        expectedAnswer,
        shouldAbstain,
        split: 'test',
        notes: 'Seeded synthetic holdout case; fictional identity.',
      });
    };

    q('drink-exact', 'stable_fact', `${name}: what is the current favorite drink?`, [{ match: currentDrink, relevance: 3, notePath: currentRel }], currentDrink);
    q('drink-paraphrase', 'semantic_paraphrase', oneOf(profileSeed, 'drinkQuery', [
      `Which beverage does ${name} prefer most now?`,
      `What does ${name} currently like to drink most?`,
      `Name ${name}'s present favorite beverage.`,
    ]), [{ match: currentDrink, relevance: 3, notePath: currentRel }], currentDrink);
    q('drink-current', 'correction_supersession', `What is ${name}'s favorite drink now, after the change?`, [
      { match: currentDrink, relevance: 3, notePath: currentRel },
      { match: previousDrink, relevance: 1, notePath: historyRel },
    ], currentDrink);
    // prefer_historical: the query explicitly asks for the OLD value, which must
    // outrank the current one. Split from prefer_current — they are opposite
    // temporal intents, and averaging them into one category hid both failures.
    q('drink-history', 'prefer_historical', `What drink did ${name} previously call the favorite before changing it?`, [
      { match: previousDrink, relevance: 3, notePath: historyRel },
      { match: currentDrink, relevance: 1, notePath: currentRel },
    ], previousDrink);
    q('city-current', 'prefer_current', oneOf(profileSeed, 'cityCurrentQuery', [
      `Where does ${name} live now?`,
      `What is ${name}'s current city?`,
      `Which city is ${name} living in at present?`,
    ]), [{ match: currentCity, relevance: 3, notePath: currentRel }], currentCity);
    q('city-history', 'temporal', `Where did ${name} live before ${currentCity}?`, [{ match: previousCity, relevance: 3, notePath: historyRel }], previousCity);
    q('instrument', 'distractor_resistance', oneOf(profileSeed, 'instrumentQuery', [
      `What instrument is ${name} learning?`,
      `Which instrument is ${name} practicing as a learner?`,
      `What musical instrument is ${name} currently studying?`,
    ]), [{ match: instrument, relevance: 3, notePath: currentRel }], instrument);
    q('project', 'stable_fact', `What project is ${name} currently building?`, [{ match: project, relevance: 3, notePath: currentRel }], project);
    q('passport-abstain', 'abstention', `What is ${name}'s passport number?`, [], null, true);

    manifestProfiles.push({ name, currentDrink, previousDrink, currentCity, previousCity, instrument, project });
  }

  const fixture = {
    version: 1,
    description: 'Seeded synthetic RenorBench holdout fixture. All people/facts are fictional.',
    relativeMtimeDays: mtimes,
  };
  const generationManifest = {
    schemaVersion: 1,
    generator: 'renor-seeded-holdout-v2',
    seedSha256: crypto.createHash('sha256').update(seed).digest('hex'),
    profiles: profileCount,
    cases: cases.length,
    generatedAt: new Date().toISOString(),
    warning: 'Keep the raw seed and generated holdout outside builder-visible Git/worktrees.',
    profileSummary: manifestProfiles,
  };

  await Promise.all([
    fsp.writeFile(path.join(output, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n', 'utf8'),
    fsp.writeFile(path.join(output, 'cases.jsonl'), jsonl(cases), 'utf8'),
    fsp.writeFile(path.join(output, 'generation-manifest.json'), JSON.stringify(generationManifest, null, 2) + '\n', 'utf8'),
  ]);

  console.log(JSON.stringify({ output, cases: cases.length, profiles: profileCount, seedSha256: generationManifest.seedSha256 }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
