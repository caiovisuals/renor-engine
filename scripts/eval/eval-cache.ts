#!/usr/bin/env node
/**
 * Inspect or invalidate the eval caches (embedding vectors + recorded model calls).
 *
 *   npm run eval:cache -- stats
 *   npm run eval:cache -- invalidate --embedding-namespace vertex/gemini-embedding-001/768
 *   npm run eval:cache -- invalidate --eval-provider 'https://host/v1#model' [--call-type judge]
 *   npm run eval:cache -- invalidate --all
 *
 * Keys already pin model, dimensions, task type and the full request body, so a
 * changed model or prompt misses by itself; invalidate is for a provider whose
 * answers drifted or a poisoned run. Nothing here calls a provider.
 */
import fs from 'node:fs';
import { Command, CommanderError } from 'commander';
import { describeEmbeddingCache, invalidateEmbeddingCache, resolveEmbeddingCachePath } from '../../src/embeddings/caching';
import { EvalCache, resolveEvalCachePath } from '../../src/eval/evalCache';

export function runEvalCacheCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const out: string[] = [];
  const program = new Command().exitOverride().configureOutput({ writeOut: s => out.push(s), writeErr: s => out.push(s) });
  const paths = (opts: { embedDb?: string; evalDb?: string }) => ({
    embed: opts.embedDb ?? resolveEmbeddingCachePath(env),
    evals: opts.evalDb ?? resolveEvalCachePath(env),
  });
  const common = (cmd: Command) => cmd
    .option('--embed-db <path>', 'embedding cache DB (default: RENOR_EVAL_EMBED_CACHE / default path)')
    .option('--eval-db <path>', 'model-call cache DB (default: RENOR_EVAL_CACHE / default path)');

  /** Opens the model-call DB only if it exists: reading or invalidating must never create a cache. */
  const withEvalCache = <T>(dbPath: string, ifMissing: T, use: (cache: EvalCache) => T): T => {
    if (!fs.existsSync(dbPath)) return ifMissing;
    const cache = new EvalCache(dbPath);
    try { return use(cache); } finally { cache.close(); }
  };

  common(program.command('stats').description('rows per namespace in each cache')).action((opts: { embedDb?: string; evalDb?: string }) => {
    const p = paths(opts);
    out.push(`embedding cache ${p.embed ?? '(disabled)'}\n`);
    for (const row of p.embed ? describeEmbeddingCache(p.embed) : []) out.push(`  ${row.namespace}: ${row.rows} vectors\n`);
    out.push(`model-call cache ${p.evals ?? '(disabled)'}\n`);
    for (const row of p.evals ? withEvalCache(p.evals, [], cache => cache.summary()) : []) out.push(`  ${row.providerNamespace} [${row.callType}]: ${row.rows} responses\n`);
  });

  common(program.command('invalidate').description('drop cached rows; one of --embedding-namespace, --eval-provider, --all is required'))
    .option('--embedding-namespace <ns>', 'drop vectors of this kind/model/dims namespace')
    .option('--eval-provider <ns>', 'drop recorded model calls of this provider namespace (baseUrl#model)')
    .option('--call-type <type>', 'with --eval-provider: only answer or judge rows')
    .option('--all', 'drop everything in both caches')
    .action((opts: { embedDb?: string; evalDb?: string; embeddingNamespace?: string; evalProvider?: string; callType?: 'answer' | 'judge'; all?: boolean }) => {
      if (!opts.embeddingNamespace && !opts.evalProvider && !opts.all) throw new Error('invalidate needs --embedding-namespace, --eval-provider or --all');
      if (opts.callType && opts.callType !== 'answer' && opts.callType !== 'judge') throw new Error('--call-type must be answer or judge');
      // Without this, `--all --call-type judge` would look narrow and still drop everything.
      if (opts.callType && !opts.evalProvider) throw new Error('--call-type narrows --eval-provider; pass both');
      const p = paths(opts);
      if ((opts.embeddingNamespace || opts.all) && p.embed) {
        out.push(`embedding vectors removed: ${invalidateEmbeddingCache(p.embed, opts.all ? { all: true } : { namespace: opts.embeddingNamespace })}\n`);
      }
      if ((opts.evalProvider || opts.all) && p.evals) {
        const removed = withEvalCache(p.evals, 0, cache => cache.invalidate(opts.all ? { all: true } : { providerNamespace: opts.evalProvider, callType: opts.callType }));
        out.push(`model-call responses removed: ${removed}\n`);
      }
    });

  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    // --help ends parsing with exit code 0 and its text is the result; a usage error carries its text in `out`.
    if (error.exitCode !== 0) throw new Error(out.join('').trim() || error.message);
  }
  return out.join('');
}

if (require.main === module) {
  try {
    process.stdout.write(runEvalCacheCommand(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
