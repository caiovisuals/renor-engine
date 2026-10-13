/**
 * Fill the write-time digest cache (RENOR_DIGESTS) for exactly the notes a LongMemEval question's retrieval window
 * holds, so a paired dev100 run can arm digests without paying to digest every haystack session.
 *
 * A digest is query-independent (it is a function of the note's text, the prompt and the model), so digesting only
 * the notes search would read gives the identical table to digesting the whole haystack: search reads the digests of
 * the window's notes and no others. For each question this script
 *   1. renders the haystack as the product runner does and runs the shipped CLI (`index`, `search --json`) with the
 *      flag OFF to learn which notes the window holds (the same hits the run's control arm sees),
 *   2. digests those notes through the product code (`digestIndexedNotes`, same model, prompt and cache key), and
 *   3. embeds their items with the run's embedding provider into the cache.
 * Gold fields are never read. Models and embeddings are reached only through the base URLs in the environment.
 *
 *   node --import tsx scripts/eval/digest-window-notes.ts --dataset <longmemeval_s.json> --ids-file <ids> \
 *     --summary <out.json> [--concurrency 4] [--limit N]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { openDb } from '../../src/db/client';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai';
import { validateLongMemRows, type LongMemInstance } from '../../src/eval/longmemeval';
import { digestIndexedNotes, resolveDigestOptions, type DigestBuildStats } from '../../src/digests/digests';
import { cliPublicSearch, writeQuestionVault } from './run-longmemeval-product';

interface CaseSummary {
  id: string;
  windowNotes: number;
  stats: DigestBuildStats;
}

async function main(): Promise<void> {
  const program = new Command()
    .requiredOption('--dataset <path>')
    .requiredOption('--ids-file <path>')
    .requiredOption('--summary <path>')
    .option('--concurrency <n>', 'questions processed at once', '4')
    .option('--limit <n>', 'only the first N ids (smoke)', '0');
  program.parse(process.argv);
  const opts = program.opts() as { dataset: string; idsFile: string; summary: string; concurrency: string; limit: string };

  if ((process.env.RENOR_DIGESTS ?? '').trim() === '') throw new Error('RENOR_DIGESTS must be set (on): this script fills the digest cache');
  if (!(process.env.RENOR_DIGEST_CACHE ?? '').trim()) throw new Error('RENOR_DIGEST_CACHE must name the shared digest cache file');
  const digestEnv = { ...process.env };

  const rows = JSON.parse(fs.readFileSync(opts.dataset, 'utf8')) as LongMemInstance[];
  validateLongMemRows(rows);
  const wanted = fs.readFileSync(path.resolve(opts.idsFile), 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const byId = new Map(rows.map(row => [row.question_id, row] as const));
  let ids = wanted.filter(id => byId.has(id));
  if (Number(opts.limit) > 0) ids = ids.slice(0, Number(opts.limit));

  const keys = (process.env.OPENAI_API_KEY ?? '').split(',').map(k => k.trim()).filter(Boolean);
  const provider = new OpenAIEmbeddingProvider(
    keys, process.env.EMBEDDING_MODEL, process.env.EMBEDDING_BASE_URL,
    process.env.EMBEDDING_DIMS ? Number(process.env.EMBEDDING_DIMS) : undefined,
  );

  const summaries: CaseSummary[] = [];
  let next = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= ids.length) return;
      const row = byId.get(ids[at])!;
      const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-digest-window-'));
      try {
        const rendered = await writeQuestionVault(workDir, row);
        const dbPath = path.join(workDir, 'product.db');
        const query = `Question date: ${row.question_date}\n${row.question}`;
        const env: Record<string, string> = {
          VAULT_PATH: rendered.vaultDir,
          DB_PATH: dbPath,
          EMBEDDING_PROVIDER: 'openai',
          LLM_EXTRACTION: 'false',
          INDEX_CONCURRENCY: process.env.RENOR_EVAL_INDEX_CONCURRENCY ?? '4',
          // The control retrieval: digests off, so the window is the one the control arm reads.
          RENOR_DIGESTS: '0',
        };
        const result = await cliPublicSearch({ query, vaultDir: rendered.vaultDir, dbPath, env, topK: 20, cwd: process.cwd() });
        const paths = new Set(result.hits.map(hit => hit.notePath).filter(p => !p.startsWith('_renor/')));
        const config = { dbPath, vaultPath: rendered.vaultDir, memoryLedger: undefined as unknown as string };
        const options = resolveDigestOptions(config, digestEnv);
        if (!options) throw new Error('digests resolved off');
        const db = openDb(dbPath);
        try {
          const stats = await digestIndexedNotes({ db, config, options, provider, onlyPaths: paths });
          summaries.push({ id: row.question_id, windowNotes: paths.size, stats });
          if (stats.failed > 0) failed++;
          process.stderr.write(`[digest-window] ${row.question_id} window=${paths.size} cached=${stats.cached} digested=${stats.digested} failed=${stats.failed} calls=${stats.calls}\n`);
        } finally {
          db.close();
        }
      } catch (err) {
        failed++;
        process.stderr.write(`[digest-window] ${row.question_id} FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        await fsp.rm(workDir, { recursive: true, force: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(opts.concurrency)) }, worker));

  const total = (pick: (s: DigestBuildStats) => number) => summaries.reduce((sum, c) => sum + pick(c.stats), 0);
  const report = {
    questions: ids.length,
    completed: summaries.length,
    questionsWithFailures: failed,
    windowNotes: summaries.reduce((sum, c) => sum + c.windowNotes, 0),
    cached: total(s => s.cached),
    digested: total(s => s.digested),
    failedNotes: total(s => s.failed),
    calls: total(s => s.calls),
    promptTokens: total(s => s.promptTokens),
    completionTokens: total(s => s.completionTokens),
    items: total(s => s.items),
    embeddedTexts: total(s => s.embeddedTexts),
    cases: summaries,
  };
  await fsp.writeFile(opts.summary, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...report, cases: undefined })}\n`);
  if (failed > 0 || summaries.length !== ids.length) process.exit(1);
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
