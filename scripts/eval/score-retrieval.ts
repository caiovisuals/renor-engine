import fs from 'node:fs';
import { scoreRetrieval, type EvalCase, type EvalResult } from '../../src/eval/scoring';

function readJsonl<T>(path: string): T[] {
  return fs.readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

const [casesPath, resultsPath] = process.argv.slice(2);
if (!casesPath || !resultsPath) {
  console.error('Usage: npx tsx scripts/eval/score-retrieval.ts <cases.jsonl> <results.jsonl>');
  process.exit(2);
}

const cases = readJsonl<EvalCase>(casesPath);
const results = readJsonl<EvalResult>(resultsPath);
console.log(JSON.stringify(scoreRetrieval(cases, results), null, 2));
