import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * The page dump (scripts/eval/dump-longmemeval-pages.ts) is step one of a two-step LongMemEval run: the pages, made with no model
 * and no key, possibly on another machine. Step two (scripts/eval/run-longmemeval-qa.ts --run <dump>) reads it and answers and grades.
 * This module is what both ends agree on: how the pages are hashed, and the check that a dump on disk is the dump its manifest
 * describes, made before the QA run spends anything. The QA manifest then carries the dump's provenance (which caches its pages came
 * from), so the output alone can show it after the dump directory is gone.
 */

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
export const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

/** The pages alone, no timings: equal for two dumps of the same questions exactly when the reader would see the same pages. */
export function pagesSha256Of(resultRows: ReadonlyArray<{ id: string; hits: unknown; [timing: string]: unknown }>): string {
  return sha256(jsonl(resultRows.map(row => ({ id: row.id, hits: row.hits }))));
}

/** What a QA run records of the dump it read. */
export interface PageDumpProvenance {
  kind: 'page-dump';
  pagesSha256: string;
  resultsSha256: string;
  casesSha256: string;
  selectedCases: number;
  /** The dump's own account of every cache it used (embeddings, index snapshots restored or built, product-process caches). */
  cachesUsed: unknown;
  gitSha: unknown;
  gitShaSource: unknown;
  gitDirty: unknown;
  noModelCalls: true;
  /** The recomputed hashes equalled the manifest's before any model call. */
  verified: true;
}

const readRows = (file: string): Array<{ id: string; hits: unknown }> =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; hits: unknown });

/**
 * Null for a run directory that is not a page dump (a retrieval run from run-longmemeval.ts). For a page dump: recompute the hashes
 * from the files and throw unless they are the manifest's, so a dump that was edited, truncated or mixed with another one is refused
 * before the first model call.
 */
export function verifyPageDump(runDir: string, manifest: Record<string, unknown>): PageDumpProvenance | null {
  if (manifest.kind !== 'page-dump') return null;
  const fail = (what: string): never => { throw new Error(`Refused: page dump ${runDir} does not match its manifest (${what}); dump it again`); };
  if (manifest.scored !== false || manifest.noModelCalls !== true) fail('a page dump is unscored and made with no model call');
  const resultsPath = path.join(runDir, 'results.jsonl');
  const casesPath = path.join(runDir, 'cases.jsonl');
  const resultsBytes = fs.readFileSync(resultsPath);
  const casesBytes = fs.readFileSync(casesPath);
  if (sha256(resultsBytes) !== manifest.resultsSha256) fail('results.jsonl hash');
  if (sha256(casesBytes) !== manifest.casesSha256) fail('cases.jsonl hash');
  const rows = readRows(resultsPath);
  if (pagesSha256Of(rows) !== manifest.pagesSha256) fail('pages hash');
  if (rows.length !== manifest.selectedCases) fail(`${rows.length} pages for ${String(manifest.selectedCases)} selected questions`);
  const ids = Array.isArray(manifest.selectionIds) ? manifest.selectionIds as string[] : [];
  if (ids.length !== rows.length || ids.some((id, index) => rows[index].id !== id)) fail('selected question ids');
  return {
    kind: 'page-dump',
    pagesSha256: manifest.pagesSha256 as string,
    resultsSha256: manifest.resultsSha256 as string,
    casesSha256: manifest.casesSha256 as string,
    selectedCases: rows.length,
    cachesUsed: manifest.cachesUsed ?? null,
    gitSha: manifest.gitSha ?? null,
    gitShaSource: manifest.gitShaSource ?? null,
    gitDirty: manifest.gitDirty ?? null,
    noModelCalls: true,
    verified: true,
  };
}
