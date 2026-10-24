import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../db/client';

/**
 * Index snapshots for LongMemEval iteration runs.
 *
 * The product runner builds one memory store per question (render the haystack as markdown, run `cli index`).
 * That store depends only on the question's haystack and on the code and configuration that decide what the
 * indexer stores, so a later run that changes only retrieval, page building or reading can restore it instead
 * of building it again. A snapshot is the SQLite file `cli index` leaves behind, copied right after the index
 * and before any search touches it.
 *
 * Correctness rests on three things, all enforced here:
 *  1. The key is a hash of everything that reaches the stored bytes: the indexing code (INDEX_CODE_PATHS, the
 *     index half of src/cli.ts, the lockfile), the environment the indexing code reads (scanned from those
 *     sources, so a new flag is in the key without anyone remembering it), the embedding identity, the Node
 *     major and platform, the vault location and the rendered haystack itself. Any difference is a miss and the
 *     store is rebuilt.
 *  2. The index stores absolute paths (notes, chunks and their full-text tables), so a snapshot only works at
 *     the path it was built at. The vault of a snapshotted question is therefore rendered at a fixed place
 *     (vaultDirFor), independent of where the snapshots themselves live, and that place is part of the key.
 *     Moving the snapshot directory to another machine works; changing the vault base builds a new set.
 *  3. A snapshot is verified (sha-256 of the file against the metadata written after it) before it is used. A
 *     missing, truncated or altered one is a rebuild, never an error and never a silent use.
 *
 * Nothing here is used for promotion arms: they build cold (the runner refuses the combination).
 */

export const SNAPSHOT_SCHEMA = 'indexsnap-v1';

/** Where the vault of a snapshotted question is rendered. On a RAM-backed temp directory by default (no SSD writes). */
export const DEFAULT_VAULT_BASE = '/tmp/renor-index-vault';

/**
 * The source that decides what `cli index` stores. Directories are hashed whole. src/retrieval/orchestrator.ts
 * is here because the indexer imports three date helpers from it (resolveSessionDate, sessionDateMs,
 * boundContentDate); a change to it re-indexes, which is the safe side. Everything else retrieval, page
 * building, evidence and the reader is deliberately NOT here: tests/eval/index-snapshots.test.ts walks the
 * import graph from the index command and fails when a module appears that is neither listed here nor named in
 * READ_PATH_ONLY, so the boundary cannot drift unnoticed.
 */
export const INDEX_CODE_PATHS: readonly string[] = [
  'src/indexer',
  'src/db',
  'src/embeddings',
  'src/extraction',
  'src/memory',
  'src/digests',
  'src/router',
  'src/net',
  'src/config.ts',
  'src/cli-extractors.ts',
  'src/context/rowStore.ts',
  'src/eval/hashEmbedding.ts',
  'src/mvp/log.ts',
  'src/mvp/scope.ts',
  'src/toolRefusal.ts',
  'src/evidence/ollamaChat.ts',
  'src/evidence/keyPool.ts',
  'src/evidence/options.ts',
  'src/retrieval/orchestrator.ts',
  'src/retrieval/entityLookup.ts',
  'src/retrieval/queryHelpers.ts',
];

/**
 * Constants the index code takes from a read-path module. The module stays out of the hash (an edit to the evidence
 * second pass is a search-time lever and must not re-index), but the declaration of each constant the index code
 * reads is hashed: the write-time digest lane and the session router fall back to EVIDENCE_MODEL_DEFAULT when no
 * model variable is set, so changing that default changes the digests and summaries a cold build stores. A name that
 * is not declared as `export const NAME ...;` in its file is an error, never a skipped entry.
 */
export const INDEX_PINNED_CONSTANTS: Readonly<Record<string, readonly string[]>> = {
  'src/evidence/secondPass.ts': ['EVIDENCE_MODEL_DEFAULT', 'EVIDENCE_REASONING_EFFORTS'],
};

/**
 * Every other binding that hashed code imports from a READ_PATH_ONLY module, with why it does not decide what an
 * index stores. tests/eval/index-snapshots.test.ts compares this with the real imports, so a new binding taken from
 * a read-path module fails until someone classifies it: pin it above, or list it here with the reason.
 * Keyed `<module>#<binding>`.
 */
export const READ_PATH_BINDINGS: Readonly<Record<string, string>> = {
  'src/evidence/attach.ts#renderEvidenceTable': 'digests.ts renders a digest table into a page at search time',
  'src/evidence/evidenceCache.ts#EvidenceCache': 'options.ts resolveEvidenceToolOptions, the search-time evidence pass',
  'src/evidence/optin.ts#EvidenceDailyBudget': 'options.ts resolveEvidenceChat, the search-time evidence pass',
  'src/evidence/optin.ts#optinEndpointAllowed': 'options.ts resolveEvidenceChat, the search-time evidence pass',
  'src/evidence/optin.ts#readOptinKey': 'options.ts resolveEvidenceChat, the search-time evidence pass',
  'src/evidence/optin.ts#resolveEvidenceOptin': 'options.ts resolveEvidenceChat, the search-time evidence pass',
  'src/evidence/optin.ts#dailyBudgetGate': 'options.ts resolveEvidenceChat, the search-time evidence pass',
  'src/evidence/gate.ts#resolveEvidenceMode': 'options.ts resolveEvidenceToolOptions, the search-time evidence pass',
  'src/evidence/secondPass.ts#MAX_EVIDENCE_SESSIONS': 'options.ts evidence bounds, search time',
  'src/evidence/secondPass.ts#EVIDENCE_SESSION_CHAR_CAP': 'options.ts evidence bounds, search time',
  'src/evidence/secondPass.ts#EvidenceExtractor': 'a type, erased at build time',
};

/** Hashed files whose environment reads the lexical scan cannot see by name, with what covers them instead. */
export const DYNAMIC_ENV_READS: Readonly<Record<string, string>> = {
  'src/evidence/keyPool.ts': 'reads the Ollama credential variables by a name list; credentials are never in the key',
  'src/memory/statusFacts.ts': 'indexes env[STATUS_FRESHNESS_FLAG], a constant whose RENOR_ literal is in the same file and so in the scan',
};

/**
 * Modules the index command can reach through an import but does not run to produce stored state: they are
 * imported by orchestrator.ts / digests.ts / the router for their search-time functions. Listed so the import
 * walk in the test names every file it does not hash, with the reason.
 */
export const READ_PATH_ONLY: readonly string[] = [
  'src/evidence/attach.ts', // digests.ts imports renderEvidenceTable, used when a page is built
  'src/evidence/evidenceCache.ts',
  'src/evidence/gate.ts',
  'src/evidence/optin.ts',
  'src/evidence/secondPass.ts', // router.ts reads the EVIDENCE_MODEL_DEFAULT constant (RENOR_EVIDENCE_MODEL is in the key)
  'src/mvp/contextRelevance.ts', // orchestrator: calibrated relevance bars at search time
  'src/retrieval/conversationShape.ts',
  'src/retrieval/dailyEntryTime.ts',
  'src/retrieval/factsFirst.ts',
  'src/retrieval/keyword.ts',
  'src/retrieval/ledgerEventTime.ts',
  'src/retrieval/ledgerLiveness.ts',
  'src/retrieval/ledgerPresentation.ts',
  'src/retrieval/plainWording.ts',
  'src/retrieval/semantic.ts',
];

/**
 * The modules the `index` command builds on: what src/cli.ts's setup() and index action construct and call. The import
 * walk in tests/eval/index-snapshots.test.ts starts here. A new dependency of the index command belongs in this list
 * and in INDEX_CODE_PATHS.
 */
export const INDEX_ENTRY_MODULES: readonly string[] = [
  'src/config.ts',
  'src/db/client.ts',
  'src/db/schema.ts',
  'src/db/sqlite.ts',
  'src/memory/lifecycle.ts',
  'src/indexer/pipeline.ts',
  'src/indexer/staleness.ts',
  'src/embeddings/vectorIndex.ts',
  'src/embeddings/openai.ts',
  'src/embeddings/local.ts',
  'src/embeddings/types.ts',
  'src/cli-extractors.ts',
  'src/extraction/typedFacts.ts',
  'src/extraction/eventExtractor.ts',
  'src/extraction/preferenceExtractor.ts',
  'src/eval/hashEmbedding.ts',
  'src/router/sessionRouter.ts',
  'src/digests/digests.ts',
];

/** Index-code files whose text is not scanned for environment names: orchestrator's flags are all search-time. */
const ENV_SCAN_EXCLUDED = new Set([
  'src/retrieval/orchestrator.ts',
  'src/retrieval/entityLookup.ts',
  'src/retrieval/queryHelpers.ts',
]);

/** Per-run values and credentials. A credential never decides what is stored, and must never reach a key or a record. */
const ENV_NEVER_KEYED = /(_KEYS?|_KEY_FILE|_SECRET|_PASSWORD|_CREDENTIALS?|_AUTH_TOKEN|_ACCESS_TOKEN|_API_TOKEN)$|^(VAULT_PATH|DB_PATH|PRIORITY_PATHS|HOME|PATH|TMPDIR|PWD)$/;

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

function listFiles(root: string, relative: string): string[] {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) throw new Error(`Index code path missing: ${relative}`);
  const stat = fs.statSync(full);
  if (stat.isFile()) return [relative];
  const out: string[] = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** src/cli.ts up to the `search` command: imports, helpers, setup() and the `index` command; the search handler is read-path. */
export function cliIndexHalf(source: string): string {
  const index = source.indexOf('.command("index")');
  const search = source.indexOf('.command("search');
  // If the file is ever reorganised so the index command no longer precedes search, hash the whole file.
  return index !== -1 && search > index ? source.slice(0, search) : source;
}

/** The text of `export const NAME ... ;` in a source file. Throws when it is not there: a pinned constant that moved must not drop out of the key. */
export function constantDeclaration(text: string, name: string, file: string): string {
  const match = new RegExp(`export const ${name}\\b[^;]*;`).exec(text);
  if (!match) throw new Error(`Pinned index constant ${name} is not declared as "export const ${name} ...;" in ${file}`);
  return match[0];
}

export interface IndexCodeIdentity {
  sha256: string;
  files: number;
  /** Environment names the indexing code reads (never values, never credentials). */
  envNames: string[];
}

export function indexCodeIdentity(repoRoot: string): IndexCodeIdentity {
  const files = [...new Set(INDEX_CODE_PATHS.flatMap(entry => listFiles(repoRoot, entry)))]
    .filter(file => /\.(ts|json)$/.test(file))
    .sort();
  const parts: string[] = [];
  const envNames = new Set<string>();
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(repoRoot, file));
    parts.push(`${file}\0${sha256(bytes)}`);
    if (!file.endsWith('.ts') || ENV_SCAN_EXCLUDED.has(file)) continue;
    const text = bytes.toString('utf8');
    for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) envNames.add(match[1]);
    for (const match of text.matchAll(/\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) envNames.add(match[1]);
    // A name held in a list or passed to a helper (envFlag('RENOR_X')) still names a variable this code reads.
    for (const match of text.matchAll(/['"`](RENOR_[A-Z0-9_]+)['"`]/g)) envNames.add(match[1]);
  }
  for (const [file, names] of Object.entries(INDEX_PINNED_CONSTANTS)) {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const name of names) parts.push(`${file}#${name}\0${sha256(constantDeclaration(text, name, file))}`);
  }
  const cli = fs.readFileSync(path.join(repoRoot, 'src/cli.ts'), 'utf8');
  parts.push(`src/cli.ts#index-half\0${sha256(cliIndexHalf(cli))}`);
  for (const match of cliIndexHalf(cli).matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) envNames.add(match[1]);
  let lock = '';
  try {
    lock = sha256(fs.readFileSync(path.join(repoRoot, 'package-lock.json')));
  } catch {
    lock = 'no-lockfile';
  }
  parts.push(`package-lock.json\0${lock}`);
  return {
    sha256: sha256(parts.join('\n')),
    files: files.length + 2,
    envNames: [...envNames].filter(name => !ENV_NEVER_KEYED.test(name)).sort(),
  };
}

/** A loopback proxy's port is a property of this run, not of the vectors: fold it away so the box and the laptop agree. */
function normalizeEndpoint(value: string): string {
  return value.replace(/^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(?=\/|$)/, '$1://loopback');
}

export interface IndexConfigInput {
  repoRoot: string;
  /** The environment the product process receives (the runner's own merged with the case environment). */
  env: NodeJS.ProcessEnv;
  /** Where the vaults are rendered; part of the key because the index stores their absolute paths. */
  vaultBase: string;
  /**
   * What produced the vectors when the endpoint is a proxy: the proxy's own namespace (for example
   * "vertex/gemini-embedding-001/768"). The model and dimension environment alone cannot tell two upstreams apart.
   */
  embeddingNamespace?: string | null;
}

export interface IndexConfig {
  /** Everything that decides what an index stores, except the question. */
  hash: string;
  /** Non-secret facts the hash was made from, recorded in each snapshot and in the run manifest. */
  components: {
    schema: string;
    codeSha256: string;
    codeFiles: number;
    envSha256: string;
    envNames: string[];
    envSet: string[];
    embeddingNamespace: string | null;
    node: string;
    platform: string;
    vaultBase: string;
  };
}

export function indexConfig(input: IndexConfigInput): IndexConfig {
  const code = indexCodeIdentity(input.repoRoot);
  const present: string[] = [];
  const values = code.envNames.map(name => {
    const raw = input.env[name];
    if (raw === undefined) return `${name}=<unset>`;
    present.push(name);
    return `${name}=${normalizeEndpoint(raw)}`;
  });
  const components: IndexConfig['components'] = {
    schema: SNAPSHOT_SCHEMA,
    codeSha256: code.sha256,
    codeFiles: code.files,
    envSha256: sha256(values.join('\n')),
    envNames: code.envNames,
    envSet: present,
    embeddingNamespace: input.embeddingNamespace ?? null,
    node: `${process.version.split('.')[0]}`,
    platform: `${process.platform}/${process.arch}`,
    vaultBase: path.resolve(input.vaultBase),
  };
  return { hash: sha256(JSON.stringify(components)), components };
}

export interface VaultFile { relativePath: string; sha256: string }

/** What the indexer reads of a rendered haystack: each file's path, bytes and modification time. */
export function vaultSignature(vaultDir: string, files: readonly VaultFile[]): string {
  const parts = files.map(file => {
    const stat = fs.statSync(path.join(vaultDir, file.relativePath));
    return `${file.relativePath}\0${file.sha256}\0${stat.mtimeMs}`;
  });
  return sha256(parts.join('\n'));
}

export function vaultDirFor(vaultBase: string, questionId: string): { root: string; vaultDir: string } {
  // The id names a directory: keep it to a safe segment, and a hash of the id so two ids can never share one.
  const segment = `${questionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)}-${sha256(questionId).slice(0, 8)}`;
  const root = path.join(path.resolve(vaultBase), segment);
  return { root, vaultDir: path.join(root, 'vault') };
}

export interface IndexReplay {
  routerSummaries?: Record<string, unknown>;
  digestStats?: Record<string, unknown>;
}

/**
 * The router/digest stats of a restored index. The build that made the snapshot made those model calls; this run
 * did not, and a record that repeated the build's counts would overstate this run's calls and tokens. The
 * counters this run spent read zero, the notes it did not have to process read as cached, and the build's own
 * line is kept whole under builtWith.
 */
export function restoredReplay(replay: IndexReplay | undefined): IndexReplay {
  const zeroed = (stats: Record<string, unknown>, cachedFrom: string | null): Record<string, unknown> => ({
    ...stats,
    ...(cachedFrom && typeof stats[cachedFrom] === 'number' ? { cached: stats[cachedFrom] } : {}),
    ...Object.fromEntries(['summarized', 'calls', 'promptTokens', 'completionTokens', 'failed'].filter(key => typeof stats[key] === 'number').map(key => [key, 0])),
    restoredFromSnapshot: true,
    builtWith: stats,
  });
  return {
    ...(replay?.routerSummaries ? { routerSummaries: zeroed(replay.routerSummaries, 'notes') } : {}),
    ...(replay?.digestStats ? { digestStats: zeroed(replay.digestStats, null) } : {}),
  };
}

export interface SnapshotMeta {
  schema: string;
  questionId: string;
  configHash: string;
  vaultSignature: string;
  dbSha256: string;
  dbBytes: number;
  createdAt: string;
  /** Wall time the build this snapshot came from spent in `cli index`. */
  indexMs: number;
  vaultDir: string;
  /** What `cli index` printed about its own router/digest calls, replayed on restore so a record reads as the cold one does. */
  indexReplay?: IndexReplay;
  gitSha?: string;
  components: IndexConfig['components'];
}

export type RestoreResult =
  | { state: 'restored'; meta: SnapshotMeta }
  | { state: 'miss' }
  | { state: 'stale' | 'corrupt'; reason: string };

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SnapshotStoreOptions {
  /** Directory the snapshots live in; created on the first save. */
  root: string;
  config: IndexConfig;
  vaultBase: string;
}

export class SnapshotStore {
  readonly stats = { restored: 0, built: 0, saved: 0, stale: 0, corrupt: 0, busy: 0, saveFailed: 0, indexMsSaved: 0 };
  private readonly dir: string;

  constructor(private readonly options: SnapshotStoreOptions) {
    this.dir = path.join(path.resolve(options.root), 'snapshots', options.config.hash.slice(0, 16));
  }

  get config(): IndexConfig { return this.options.config; }

  private files(questionId: string): { db: string; meta: string } {
    const name = `${questionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)}-${sha256(questionId).slice(0, 8)}`;
    return { db: path.join(this.dir, `${name}.db`), meta: path.join(this.dir, `${name}.json`) };
  }

  /**
   * Take the vault slot of a question: two runs on one machine must not render into the same place at once. A
   * lock held by a live process means "build this one the ordinary way" (null).
   */
  claim(questionId: string): { vaultDir: string; root: string; release: () => void } | null {
    const { root, vaultDir } = vaultDirFor(this.options.vaultBase, questionId);
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    const lockPath = `${root}.lock`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        fs.closeSync(fd);
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        return {
          root,
          vaultDir,
          release: () => {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(lockPath, { force: true });
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner = 0;
        try { owner = (JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number }).pid ?? 0; } catch { /* torn lock: stale */ }
        if (owner && processAlive(owner)) {
          this.stats.busy++;
          return null;
        }
        fs.rmSync(lockPath, { force: true }); // a crashed owner's lock
      }
    }
    this.stats.busy++;
    return null;
  }

  /** Put the snapshot of a question at dbPath when it is current and intact. */
  restore(questionId: string, signature: string, dbPath: string): RestoreResult {
    const { db, meta: metaPath } = this.files(questionId);
    if (!fs.existsSync(metaPath) && !fs.existsSync(db)) return { state: 'miss' };
    let meta: SnapshotMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SnapshotMeta;
    } catch {
      this.stats.corrupt++;
      return { state: 'corrupt', reason: 'metadata missing or unreadable' };
    }
    const { vaultDir } = vaultDirFor(this.options.vaultBase, questionId);
    if (meta.schema !== SNAPSHOT_SCHEMA || meta.questionId !== questionId || meta.configHash !== this.options.config.hash
      || meta.vaultSignature !== signature || meta.vaultDir !== vaultDir) {
      this.stats.stale++;
      return { state: 'stale', reason: 'key mismatch' };
    }
    try {
      const stat = fs.statSync(db);
      if (stat.size !== meta.dbBytes || sha256File(db) !== meta.dbSha256) {
        this.stats.corrupt++;
        return { state: 'corrupt', reason: 'snapshot file does not match its recorded hash' };
      }
      fs.copyFileSync(db, dbPath);
      // The copy is what the search will open: it must be the bytes that were verified.
      if (sha256File(dbPath) !== meta.dbSha256) {
        fs.rmSync(dbPath, { force: true });
        this.stats.corrupt++;
        return { state: 'corrupt', reason: 'copy does not match the verified snapshot' };
      }
    } catch (error) {
      fs.rmSync(dbPath, { force: true });
      this.stats.corrupt++;
      return { state: 'corrupt', reason: error instanceof Error ? error.message : String(error) };
    }
    this.stats.restored++;
    this.stats.indexMsSaved += meta.indexMs;
    return { state: 'restored', meta };
  }

  /** Save the index just built at dbPath. A failure to save never fails the run: the next run builds again. */
  save(args: { questionId: string; signature: string; dbPath: string; indexMs: number; replay?: IndexReplay; gitSha?: string }): boolean {
    this.stats.built++;
    const { db, meta: metaPath } = this.files(args.questionId);
    try {
      // The index holds every haystack statement in plain text: owner-only, as the index itself is.
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // Fold the write-ahead log into the file; a snapshot is one self-contained file.
      const handle = openDb(args.dbPath);
      try { handle.pragma('wal_checkpoint(TRUNCATE)'); } finally { handle.close(); }
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(`${args.dbPath}${suffix}`) && fs.statSync(`${args.dbPath}${suffix}`).size > 0) {
          throw new Error(`index still has a ${suffix} file after checkpoint`);
        }
      }
      const tmp = `${db}.${process.pid}.tmp`;
      fs.copyFileSync(args.dbPath, tmp);
      fs.chmodSync(tmp, 0o600);
      const meta: SnapshotMeta = {
        schema: SNAPSHOT_SCHEMA,
        questionId: args.questionId,
        configHash: this.options.config.hash,
        vaultSignature: args.signature,
        dbSha256: sha256File(tmp),
        dbBytes: fs.statSync(tmp).size,
        createdAt: new Date().toISOString(),
        indexMs: Math.round(args.indexMs),
        vaultDir: vaultDirFor(this.options.vaultBase, args.questionId).vaultDir,
        ...(args.replay && Object.keys(args.replay).length > 0 ? { indexReplay: args.replay } : {}),
        ...(args.gitSha ? { gitSha: args.gitSha } : {}),
        components: this.options.config.components,
      };
      // The metadata is the commit: written last, so a reader never sees metadata without its file.
      fs.renameSync(tmp, db);
      const metaTmp = `${metaPath}.${process.pid}.tmp`;
      fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(metaTmp, metaPath);
      this.stats.saved++;
      return true;
    } catch (error) {
      this.stats.saveFailed++;
      process.stderr.write(`[snapshots] not saved for ${args.questionId}: ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    }
  }
}

// ─── report and prune (scripts/eval/index-snapshots.ts) ───

export interface SnapshotSetReport {
  configHash16: string;
  snapshots: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
  /** Node, platform, vault base and embedding namespace the set was built under. */
  built: { node: string; platform: string; vaultBase: string; embeddingNamespace: string | null } | null;
}

export function snapshotReport(root: string): { root: string; totalBytes: number; sets: SnapshotSetReport[] } {
  const base = path.join(path.resolve(root), 'snapshots');
  const sets: SnapshotSetReport[] = [];
  if (fs.existsSync(base)) {
    for (const set of fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const dir = path.join(base, set.name);
      let bytes = 0;
      let snapshots = 0;
      let oldest: string | null = null;
      let newest: string | null = null;
      let built: SnapshotSetReport['built'] = null;
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        bytes += fs.statSync(full).size;
        if (!file.endsWith('.json')) continue;
        snapshots++;
        try {
          const meta = JSON.parse(fs.readFileSync(full, 'utf8')) as SnapshotMeta;
          if (!oldest || meta.createdAt < oldest) oldest = meta.createdAt;
          if (!newest || meta.createdAt > newest) newest = meta.createdAt;
          built ??= { node: meta.components.node, platform: meta.components.platform, vaultBase: meta.components.vaultBase, embeddingNamespace: meta.components.embeddingNamespace };
        } catch { /* a torn metadata file still counts its bytes */ }
      }
      sets.push({ configHash16: set.name, snapshots, bytes, oldest, newest, built });
    }
  }
  sets.sort((a, b) => (b.newest ?? '').localeCompare(a.newest ?? ''));
  return { root: path.resolve(root), totalBytes: sets.reduce((sum, set) => sum + set.bytes, 0), sets };
}

export interface PruneOptions {
  /** Remove sets whose newest snapshot is older than this many days. */
  olderThanDays?: number;
  /** Keep this many most recently written sets, remove the rest. */
  keepLatest?: number;
  /** Remove these sets (config hash prefix). */
  configs?: string[];
  dryRun?: boolean;
  now?: number;
}

export function pruneSnapshots(root: string, options: PruneOptions): { removed: SnapshotSetReport[]; bytes: number; dryRun: boolean } {
  if (options.olderThanDays === undefined && options.keepLatest === undefined && !(options.configs?.length)) {
    throw new Error('prune needs --older-than, --keep-latest or --config: it never removes everything by default');
  }
  const report = snapshotReport(root);
  const now = options.now ?? Date.now();
  const doomed = new Set<string>();
  report.sets.forEach((set, index) => {
    if (options.keepLatest !== undefined && index >= options.keepLatest) doomed.add(set.configHash16);
    if (options.olderThanDays !== undefined && (!set.newest || now - Date.parse(set.newest) > options.olderThanDays * 86_400_000)) doomed.add(set.configHash16);
    if (options.configs?.some(prefix => prefix && set.configHash16.startsWith(prefix))) doomed.add(set.configHash16);
  });
  const removed = report.sets.filter(set => doomed.has(set.configHash16));
  if (!options.dryRun) {
    for (const set of removed) fs.rmSync(path.join(path.resolve(root), 'snapshots', set.configHash16), { recursive: true, force: true });
  }
  return { removed, bytes: removed.reduce((sum, set) => sum + set.bytes, 0), dryRun: Boolean(options.dryRun) };
}

/**
 * Snapshot directory: flag, else RENOR_EVAL_SNAPSHOT_DIR, else `index-snapshots` in the benchmark data directory
 * (RENOR_BENCH_DATA), else the user's cache directory. The last default names no machine's own layout.
 */
export function resolveSnapshotRoot(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (flag?.trim()) return path.resolve(flag);
  if (env.RENOR_EVAL_SNAPSHOT_DIR?.trim()) return path.resolve(env.RENOR_EVAL_SNAPSHOT_DIR);
  if (env.RENOR_BENCH_DATA?.trim()) return path.join(path.resolve(env.RENOR_BENCH_DATA), 'index-snapshots');
  return path.join(path.resolve(env.HOME ?? '.'), '.cache', 'renor-eval', 'index-snapshots');
}

export function resolveVaultBase(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(flag?.trim() || env.RENOR_EVAL_SNAPSHOT_VAULT_BASE?.trim() || DEFAULT_VAULT_BASE);
}
