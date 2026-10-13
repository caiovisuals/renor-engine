/**
 * Summarise a V8 .cpuprofile (from `mcp-latency.ts --cpu-profile`, or `node --cpu-prof`): where the time is,
 * by function (self and inclusive), by area of the code base, and by caller of a named function.
 *
 *   npx tsx scripts/bench/cpuprofile-summary.ts out.cpuprofile [--per 650] [--top 25] [--callers name,name]
 *
 * --per N      divide every time by N so the table reads in ms per call (N = runs x calls in the profile).
 * --top N      rows per table (default 25).
 * --callers    for each named function, the functions that call it and what share of its inclusive time each owns.
 *
 * Self time is the time the sampler found the function itself on top of the stack. Inclusive time is the time it was
 * anywhere on the stack, counted once per sample however often it recurs. Native frames (a better-sqlite3 statement,
 * a crypto call) have no JS of their own, so their time lands on the named native function when V8 reports one and
 * on the JS function that called it when it does not; the SQL a statement runs is the whole of that call's time,
 * since better-sqlite3 is synchronous.
 */
import fs from 'fs';

interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
interface CpuProfile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: cpuprofile-summary.ts <file.cpuprofile> [--per N] [--top N] [--callers a,b]');
  process.exit(2);
}
const profile = JSON.parse(fs.readFileSync(file, 'utf8')) as CpuProfile;
const per = Number(arg('per') ?? 1);
const top = Number(arg('top') ?? 25);

const byId = new Map<number, ProfileNode>();
const parent = new Map<number, number>();
for (const n of profile.nodes) byId.set(n.id, n);
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const shortUrl = (url: string): string => {
  if (!url) return '';
  const m = url.match(/(?:engine\/)?(src\/.*|node_modules\/(?:@[^/]+\/)?[^/]+)/);
  if (m) return m[1].replace(/^node_modules\//, 'nm:');
  return url.replace(/^node:/, 'node:').replace(/^file:\/\//, '');
};
const keyOf = (n: ProfileNode): string => {
  const f = n.callFrame;
  const name = f.functionName || '(anonymous)';
  const where = shortUrl(f.url);
  return where ? `${name} ${where}:${f.lineNumber + 1}` : name;
};
const areaOf = (n: ProfileNode): string => {
  const f = n.callFrame;
  if (!f.url) return f.functionName.startsWith('(') ? f.functionName : 'native (no JS frame)';
  const m = f.url.match(/engine\/(src\/[^/]+)\//) ?? f.url.match(/(src\/[^/]+)\//);
  if (m) return m[1];
  const nm = f.url.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (nm) return `nm:${nm[1]}`;
  if (f.url.startsWith('node:')) return 'node internals';
  return f.url.includes('/scripts/') ? 'bench harness' : 'other';
};

// time of sample i = delta to the next sample (the last one gets the mean)
const n = profile.samples.length;
const mean = profile.timeDeltas.reduce((a, b) => a + b, 0) / Math.max(1, n);
const dt = (i: number): number => (i + 1 < n ? profile.timeDeltas[i + 1] : mean);

const self = new Map<string, number>();
const incl = new Map<string, number>();
const area = new Map<string, number>();
const callerShare = new Map<string, Map<string, number>>();
const wanted = new Set((arg('callers') ?? '').split(',').filter(Boolean));
let total = 0;
for (let i = 0; i < n; i++) {
  const t = dt(i);
  total += t;
  const leaf = byId.get(profile.samples[i])!;
  self.set(keyOf(leaf), (self.get(keyOf(leaf)) ?? 0) + t);
  area.set(areaOf(leaf), (area.get(areaOf(leaf)) ?? 0) + t);
  const seen = new Set<string>();
  for (let id: number | undefined = leaf.id; id !== undefined; id = parent.get(id)) {
    const node = byId.get(id)!;
    const k = keyOf(node);
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + t);
    if (wanted.has(node.callFrame.functionName)) {
      const caller = parent.get(id) !== undefined ? keyOf(byId.get(parent.get(id)!)!) : '(root)';
      const m = callerShare.get(k) ?? new Map<string, number>();
      m.set(caller, (m.get(caller) ?? 0) + t);
      callerShare.set(k, m);
    }
  }
}

const ms = (us: number): string => (us / 1000 / per).toFixed(per > 1 ? 3 : 1).padStart(9);
const pct = (us: number): string => `${((us / total) * 100).toFixed(1)}%`.padStart(6);
const table = (title: string, rows: Array<[string, number]>, limit = top): void => {
  console.log(`\n${title}`);
  for (const [k, v] of rows.sort((a, b) => b[1] - a[1]).slice(0, limit)) console.log(`${ms(v)} ms ${pct(v)}  ${k}`);
};

console.log(`${file}: ${(total / 1e6).toFixed(2)} s sampled, ${n} samples (${(mean).toFixed(0)} us mean interval)${per > 1 ? `, shown per call (/${per})` : ''}`);
table('BY AREA (self time)', [...area]);
table(`TOP ${top} BY SELF TIME`, [...self]);
table(`TOP ${top} ENGINE FUNCTIONS BY INCLUSIVE TIME (src/ only)`, [...incl].filter(([k]) => / src\//.test(k)));
for (const [k, m] of callerShare) {
  table(`CALLERS OF ${k} (inclusive ${ms(incl.get(k) ?? 0).trim()} ms)`, [...m], 8);
}
