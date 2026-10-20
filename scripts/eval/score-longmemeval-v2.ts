import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { scoreQaRuns } from './longmemeval-v2/runner';

/**
 * Offline LongMemEval-V2 scorer: recomputes the upstream aggregated metrics (overall, per category, abstention)
 * from one or more QA runs' qa-cases.jsonl, with no model calls. Pass the web and the enterprise run together to
 * get upstream's combined figure. Every report is RESEARCH-ONLY (the runner calls product internals in-process).
 */

const program = new Command()
  .name('score-longmemeval-v2')
  .requiredOption('--qa <dir...>', 'QA run directory (repeat or list several: one per domain)')
  .requiredOption('--output <path>', 'report JSON path')
  .parse(process.argv);
const opts = program.opts<{ qa: string[]; output: string }>();

const report = scoreQaRuns(opts.qa);
fs.writeFileSync(path.resolve(opts.output), JSON.stringify(report, null, 2) + '\n', 'utf8');
const { failures: _failures, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
