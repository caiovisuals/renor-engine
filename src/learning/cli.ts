import fs from 'node:fs';
import { learningDbPath, learningRetentionDays } from './settings';
import { LearningLog } from './store';

/**
 * Manage one memory folder's learning log: `status`, `export`, `prune` and `delete-all`. They work whether or not recording is
 * on, so a log written before it was switched off can still be read or deleted, and they never create a log that does not exist.
 *
 *   MVP_MEMORY_DIR=<memory folder> npx tsx src/learning/cli.ts status
 *   MVP_MEMORY_DIR=<memory folder> npx tsx src/learning/cli.ts export [--out <file>]     (the file is written owner-only)
 *   MVP_MEMORY_DIR=<memory folder> npx tsx src/learning/cli.ts prune
 *   MVP_MEMORY_DIR=<memory folder> npx tsx src/learning/cli.ts delete-all --yes
 *
 * Stop a running server before deleting, as the data-deletion runbook does; a running server would otherwise keep its open
 * handle to the file. The counts and the export never contain a key secret or a memory's text.
 */

const USAGE = 'usage: learning-cli <status | export [--out <file>] | prune | delete-all --yes>';

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  const memoryDir = (env.MVP_MEMORY_DIR ?? '').trim();
  if (memoryDir === '') throw new Error('MVP_MEMORY_DIR is required: the memory folder whose learning log this manages');
  const [command, ...rest] = argv;
  const file = learningDbPath(memoryDir);
  const open = (): LearningLog => {
    const log = LearningLog.open(file, { retentionDays: learningRetentionDays(env), rawQueries: false, create: false });
    if (log === null) throw new Error(`no learning log at ${file}: nothing has been recorded there`);
    return log;
  };
  switch (command) {
    case 'status': {
      const log = LearningLog.open(file, { retentionDays: learningRetentionDays(env), rawQueries: false, create: false });
      if (log === null) {
        print({ present: false, file });
        return;
      }
      try {
        print({ present: true, file, retentionDays: learningRetentionDays(env), counts: log.counts() });
      } finally {
        log.close();
      }
      return;
    }
    case 'export': {
      const out = rest[0] === '--out' ? rest[1] : undefined;
      if (rest[0] === '--out' && (out === undefined || out === '')) throw new Error(USAGE);
      const log = open();
      let text: string;
      try {
        text = `${JSON.stringify(log.exportLog(), null, 2)}\n`;
      } finally {
        log.close();
      }
      if (out === undefined) {
        process.stdout.write(text);
      } else {
        fs.writeFileSync(out, text, { mode: 0o600 });
        process.stderr.write(`wrote ${out}\n`);
      }
      return;
    }
    case 'prune': {
      const log = open();
      try {
        print(log.prune());
      } finally {
        log.close();
      }
      return;
    }
    case 'delete-all': {
      if (rest[0] !== '--yes') throw new Error('delete-all removes every recorded row and needs --yes');
      const log = LearningLog.open(file, { retentionDays: learningRetentionDays(env), rawQueries: false, create: false });
      if (log === null) {
        print({ deleted: false, file, reason: 'no learning log' });
        return;
      }
      try {
        log.deleteAll();
        print({ deleted: true, file, counts: log.counts() });
      } finally {
        log.close();
      }
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
