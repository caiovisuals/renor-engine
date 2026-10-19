import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { bearerTokenGuard, LOCAL_API_HOSTNAMES } from './apiAuth';
import Database from 'better-sqlite3';
import { retrieveContext } from '../retrieval/orchestrator';
import { ledgerNoteMatcher, presentLedgerEvents } from '../retrieval/ledgerPresentation';
import { lookupEntity } from '../retrieval/entityLookup';
import { appendDailyMemory } from '../memory/writer';
import { remember, factsFor, DEFAULT_LEDGER_REL, LifecycleInputError } from '../memory/lifecycle';
import { VectorIndex } from '../embeddings/vectorIndex';
import { attachSearchEvidence, searchEvidenceEnabled, EVIDENCE_HIT_PATH } from '../evidence/attach';
import { createEvidenceExtractor, resolveEvidenceToolOptions } from '../evidence/options';
import { composeQueryContextFromDb, structuredContextEnabled } from '../context/composer';
import { readHonestyEnabled, readHonestyForItems } from '../context/readHonesty';
import { readBuildIdentity } from '../buildIdentity';

interface ProviderLike { embed(texts: string[]): Promise<number[][]>; dimensions: number }

export function createServer(
  db: Database.Database,
  vectorIndex: VectorIndex | undefined,
  provider: ProviderLike | undefined,
  vaultPath: string,
  priorityPaths?: string[],
  memoryDir?: string,
  ledgerPath?: string,
  options?: { apiToken?: string },
) {
  // Fail closed: there is no unauthenticated way to build this server.
  const apiToken = options?.apiToken?.trim();
  if (!apiToken) throw new Error('createServer needs options.apiToken: the HTTP API does not run without a bearer token');
  const app = express();
  // DNS-rebinding guard first: a page that rebinds its own domain to 127.0.0.1 sends its own Host, and is refused
  // before any route (or the token check) runs. Then the credential every other local user lacks.
  app.use(hostHeaderValidation(LOCAL_API_HOSTNAMES));
  app.use(bearerTokenGuard(apiToken));
  app.use(express.json());
  // Resolve the optional evidence path once per server, not once per request.
  // This avoids opening a new SQLite evidence-cache connection on every search.
  const productEvidenceEnabled = searchEvidenceEnabled();
  const productEvidenceOptions = productEvidenceEnabled
    ? resolveEvidenceToolOptions({ dbPath: db.name })
    : null;
  const productEvidenceExtractor = productEvidenceOptions
    ? createEvidenceExtractor(productEvidenceOptions)
    : null;
  // C0 shared composer (ADR-0003 §5): opt-in via RENOR_STRUCTURED_CONTEXT,
  // default OFF — when off, responses are byte-identical to the pre-C0 contract.
  const structuredOn = structuredContextEnabled();
  // Relative to the vault root — remember() joins it onto vaultPath.
  const config_ledgerPath = ledgerPath ?? DEFAULT_LEDGER_REL;
  // The ledger is the engine's own record, not a memory: this route returns neither its header nor the markup of its records.
  const isLedger = ledgerNoteMatcher({ memoryDir: vaultPath, ledgerRelPath: config_ledgerPath });

  // Build/deploy identity: which source commit is this process running? Written
  // at build time by scripts/ci/stamp-build.mjs and read through the shared,
  // non-throwing helper (src/buildIdentity.ts) that the MVP's GET /version also
  // uses. Deploy drift must be observable; the manifest never throws.
  app.get('/api/health', (req: any, res: any) => {
    res.json({ ok: true, name: 'renor', version: '1.0.0', ...readBuildIdentity() });
  });

  app.post('/retrieve-context', async (req: any, res: any) => {
    const { query, topK: rawTopK = 20 } = req.body;
    if (!query) return void res.status(400).json({ error: 'query required' });
    const topK = Math.min(100, Math.max(1, Math.floor(Number(rawTopK) || 20)));
    // LANE 3 read-time honesty (RENOR_READ_HONESTY, default OFF): provenance +
    // contradiction + abstention alongside the unchanged hits array.
    const readHonesty = (hits: any[]) =>
      readHonestyEnabled()
        ? {
            readHonesty: readHonestyForItems({
              db, query, items: hits, ledgerRelPath: config_ledgerPath,
            }),
          }
        : {};
    try {
      const retrieved = await retrieveContext(db, vectorIndex, provider, query, topK, priorityPaths, {}, { isLedgerNote: isLedger });
      if (!productEvidenceEnabled || !productEvidenceOptions) {
        // Preserve the pre-evidence response contract exactly when the feature is off.
        const plain = presentLedgerEvents(retrieved.hits, isLedger);
        return void res.json({
          query: retrieved.query,
          hits: plain,
          ...(structuredOn
            ? { composedContext: composeQueryContextFromDb(db, { query: retrieved.query, hits: plain }) }
            : {}),
          ...readHonesty(plain),
        });
      }
      const attached = await attachSearchEvidence({
        query,
        hits: retrieved.hits,
        vaultPath,
        options: productEvidenceOptions,
        extractor: productEvidenceExtractor,
        enabled: true,
      });
      // The evidence pass read the sources as stored; what the caller is shown is what the user said.
      const shown = presentLedgerEvents(attached.hits, isLedger);
      res.json({
        query: retrieved.query,
        hits: shown,
        evidence: attached.evidence,
        ...(structuredOn
          ? { composedContext: composeQueryContextFromDb(db, { query: retrieved.query, hits: shown.filter((h) => h.notePath !== EVIDENCE_HIT_PATH), evidence: attached.evidence }) }
          : {}),
        ...readHonesty(shown),
      });
    }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/entity/:name', (req: any, res: any) => {
    const entity = lookupEntity(db, req.params.name);
    if (!entity) return void res.status(404).json({ error: 'not found' });
    res.json(entity);
  });

  app.get('/facts/:entityId', (req: any, res: any) => {
    // Current-only by default (temporal-memory contract): superseded facts carry
    // valid_to and are opt-in via history/asOf endpoints, never the ID route.
    const rows = db.prepare(
      'SELECT * FROM facts WHERE subject_entity_id = ? AND valid_to IS NULL ORDER BY updated_at DESC'
    ).all(Number(req.params.entityId));
    res.json(rows);
  });


  app.post('/memory/daily', async (req: any, res: any) => {
    const { date, text, source = 'api' } = req.body;
    if (!date || !text) return void res.status(400).json({ error: 'date and text required' });
    try { await appendDailyMemory(vaultPath, date, { text, source }, memoryDir); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Lifecycle-backed durable memory (ledger-first, supersedes, idempotent, returns receipt).
  app.post('/memory/fact', async (req: any, res: any) => {
    const { subject, predicate, object, source } = req.body;
    if (!subject || !predicate || !object) return void res.status(400).json({ error: 'subject, predicate, object required' });
    try { res.json(await remember(db, vaultPath, config_ledgerPath, { subject, predicate, object, source })); }
    catch (e: any) {
      // A rejected lifecycle FIELD is the caller's mistake, not an engine fault: remember()
      // validates every field before touching the ledger, so this is a bad request and must
      // answer 4xx. Answering 500 made a client-side type bug (a non-string `object`) look like
      // a server outage. Engine faults — unreadable ledger, reused event id, clock regression,
      // an escaping ledger path — still throw plain Errors and stay 500.
      if (e instanceof LifecycleInputError) return void res.status(400).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // Facts by entity NAME (agents don't know DB ids). ?asOf=ISO&history=1
  app.get('/facts-for/:name', (req: any, res: any) => {
    try {
      res.json(factsFor(db, req.params.name, {
        asOf: req.query.asOf as string | undefined,
        includeHistory: req.query.history === '1' || req.query.history === 'true',
      }));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // One generic answer for anything a route did not handle: Express's own error page names the absolute path of the
  // file that threw. The cause stays in this process's log.
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status >= 500) console.error('[serve] request failed:', err);
    res.status(status).json({ error: status >= 500 ? 'internal error' : 'bad request' });
  });

  return app;
}
