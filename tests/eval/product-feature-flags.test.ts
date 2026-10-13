import { describe, it, expect } from 'vitest';
import {
  PRODUCT_FEATURE_FLAGS,
  productFeatureFlagOverrides,
} from '../../src/eval/runManifest';
import { runProductBenchmark, parseProductArgs, type ProductHooks } from '../../scripts/eval/run-longmemeval-product';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * C2–C5 screen gating contract: the product runner may arm the shipped
 * default-off extraction/composition flags (RENOR_TYPED_FACTS, RENOR_CHRONICLE,
 * RENOR_PREFS, RENOR_QUERY_SCOPED_ROWS) ONLY via the explicit env passthrough,
 * and every armed flag must be recorded in the manifest's productMode.overrides
 * so a screen arm is self-describing. Flags absent from the env must NOT be
 * passed through (default-off stays default-off).
 */

const FLAG_NAMES = PRODUCT_FEATURE_FLAGS.map(f => f.env);

/** `runProductBenchmark` types its manifest `Record<string, unknown>`; read the one field these tests assert on, checked. */
function overridesOf(manifest: Record<string, unknown>): string[] {
  const { productMode } = manifest;
  if (typeof productMode !== 'object' || productMode === null || !('overrides' in productMode) || !Array.isArray(productMode.overrides)) {
    throw new Error('manifest.productMode.overrides is not recorded');
  }
  return productMode.overrides;
}

describe('product feature flags (C2–C5 screen arming)', () => {
  it('exports exactly the shipped default-off feature flags and the knobs that tell their arms apart', () => {
    expect(FLAG_NAMES.sort()).toEqual([
      'RENOR_CHRONICLE',
      'RENOR_DIGESTS',
      'RENOR_DIGEST_MODEL',
      'RENOR_DIGEST_REASONING_EFFORT',
      'RENOR_DIGEST_TOKENS',
      'RENOR_EVIDENCE_ENUMERATE',
      'RENOR_EVIDENCE_MAX_TOKENS',
      'RENOR_EVIDENCE_MODE',
      'RENOR_EVIDENCE_REASONING_EFFORT',
      'RENOR_EVIDENCE_SESSIONS',
      'RENOR_PREFS',
      'RENOR_QUERY_SCOPED_ROWS',
      'RENOR_ROUTER_MODEL',
      'RENOR_ROUTER_SUMMARY_MODEL',
      'RENOR_SESSION_DIVERSITY',
      'RENOR_SESSION_EXPAND',
      'RENOR_SESSION_EXPAND_DOCUMENT_STATEMENT_TOKENS',
      'RENOR_SESSION_EXPAND_STATEMENT_TOKENS',
      'RENOR_SESSION_EXPAND_TOKENS',
      'RENOR_SESSION_ROUTER',
      'RENOR_STRIP_EXCERPT_META',
      'RENOR_STRUCTURED_CONTEXT',
      'RENOR_TYPED_FACTS',
    ]);
  });

  it('records the session-router arm and its models, so a router arm can never share a control\'s provenance', () => {
    expect(productFeatureFlagOverrides({ RENOR_SESSION_ROUTER: 'replace', RENOR_ROUTER_MODEL: 'm1', RENOR_ROUTER_SUMMARY_MODEL: 'm2' }))
      .toEqual(['RENOR_SESSION_ROUTER=replace', 'RENOR_ROUTER_MODEL=m1', 'RENOR_ROUTER_SUMMARY_MODEL=m2']);
    expect(productFeatureFlagOverrides({ RENOR_SESSION_ROUTER: 'union' }))
      .not.toEqual(productFeatureFlagOverrides({ RENOR_SESSION_ROUTER: 'replace' }));
  });

  it('records the write-time digest arm and what changes it, so a digest arm can never share a control\'s provenance', () => {
    expect(productFeatureFlagOverrides({ RENOR_DIGESTS: '1', RENOR_DIGEST_MODEL: 'm1', RENOR_DIGEST_TOKENS: '300' }))
      .toEqual(['RENOR_DIGESTS=1', 'RENOR_DIGEST_MODEL=m1', 'RENOR_DIGEST_TOKENS=300']);
    expect(productFeatureFlagOverrides({ RENOR_DIGESTS: '1' })).not.toEqual(productFeatureFlagOverrides({}));
  });

  it('passes armed flags through and omits unset ones', () => {
    const overrides = productFeatureFlagOverrides({
      RENOR_TYPED_FACTS: '1',
      RENOR_QUERY_SCOPED_ROWS: '1',
      RENOR_UNRELATED: '1',
    } as Record<string, string>);
    expect(overrides).toEqual(['RENOR_TYPED_FACTS=1', 'RENOR_QUERY_SCOPED_ROWS=1']);
    // Not the unrelated variable:
    expect(overrides.join()).not.toContain('RENOR_UNRELATED');
  });

  it('records the session expansion and its budget so two budget arms cannot share provenance', () => {
    expect(productFeatureFlagOverrides({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: '1000' }))
      .toEqual(['RENOR_SESSION_EXPAND=5', 'RENOR_SESSION_EXPAND_TOKENS=1000']);
    expect(productFeatureFlagOverrides({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: '1000' }))
      .not.toEqual(productFeatureFlagOverrides({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: '2000' }));
  });

  it('records the longest expansion statement so two statement-limit arms cannot share provenance', () => {
    expect(productFeatureFlagOverrides({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '100' }))
      .toEqual(['RENOR_SESSION_EXPAND_STATEMENT_TOKENS=100']);
    expect(productFeatureFlagOverrides({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '100' }))
      .not.toEqual(productFeatureFlagOverrides({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '200' }));
    expect(productFeatureFlagOverrides({ RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '100' }))
      .not.toEqual(productFeatureFlagOverrides({}));
    // Next to the other two expansion settings, in the order they are declared.
    expect(productFeatureFlagOverrides({ RENOR_SESSION_EXPAND: '5', RENOR_SESSION_EXPAND_TOKENS: '2000', RENOR_SESSION_EXPAND_STATEMENT_TOKENS: '100' }))
      .toEqual(['RENOR_SESSION_EXPAND=5', 'RENOR_SESSION_EXPAND_TOKENS=2000', 'RENOR_SESSION_EXPAND_STATEMENT_TOKENS=100']);
  });

  it('records the evidence-gate policy so two arms cannot share provenance', () => {
    // Regression: the auto (shipped) and always (champion-parity) arms are a
    // measured one-variable pair; before this entry both produced identical
    // productMode.overrides, i.e. an arm that could not describe itself.
    expect(productFeatureFlagOverrides({ RENOR_EVIDENCE_MODE: 'always' }))
      .toEqual(['RENOR_EVIDENCE_MODE=always']);
    expect(productFeatureFlagOverrides({ RENOR_EVIDENCE_MODE: 'auto' }))
      .toEqual(['RENOR_EVIDENCE_MODE=auto']);
    expect(productFeatureFlagOverrides({ RENOR_EVIDENCE_MODE: 'auto' }))
      .not.toEqual(productFeatureFlagOverrides({ RENOR_EVIDENCE_MODE: 'always' }));
  });

  it('records armed flags in the manifest overrides', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-flags-'));
    const captured: Array<Record<string, string>> = [];
    const hooks: Partial<ProductHooks> = {
      publicSearch: async (args) => {
        captured.push({ ...args.env });
        return {
          hits: [{ notePath: path.join(args.vaultDir, 'Sessions', 'a-1.md'), text: 'alpha body', score: 0.9 }],
          transport: 'test',
          command: 'test',
          durationMs: 1,
        };
      },
      models: {
        modelCall: async (_callType, requestBody) => {
          const messages = (requestBody as { messages: Array<{ role: string; content: string }> }).messages;
          const isJudge = JSON.stringify(requestBody).includes("role\": \"system\", content: 'You are an impartial");
          return {
            rawContent: isJudge ? '1' : 'Business',
            modelEcho: 'stub',
            finishReason: 'stop',
            latencyMs: 1,
            promptTokens: 10,
            completionTokens: 2,
            ...({ messages } as object),
          };
        },
        sentinel: async () => undefined,
      },
    };
    // Smoke fixture: single-instance dataset with one question.
    const datasetPath = path.join(root, 'ds.json');
    fs.writeFileSync(datasetPath, JSON.stringify([{
      question_id: 'flagtest-1',
      question: 'What business did the user study?',
      question_date: '2023/05/30 (Tue) 23:40',
      answer: 'Business Administration',
      answer_session_ids: ['s1'],
      question_type: 'single-session-user',
      haystack_session_ids: ['s1'],
      haystack_sessions: [[{ role: 'user', content: 'I study business administration.' }]],
      haystack_dates: ['2023/05/01'],
    }]));
    const prevTyped = process.env.RENOR_TYPED_FACTS;
    process.env.RENOR_TYPED_FACTS = '1';
    try {
      const opts = parseProductArgs([
        '--dataset', datasetPath,
        '--output', path.join(root, 'out'),
        '--embedding-provider', 'eval-hash',
        '--transport-smoke',
        '--limit', '0',
        '--shard-index', '0',
        '--shard-count', '1',
        '--max-live-calls', '10',
        '--no-cache',
      ]);
      const { manifest } = await runProductBenchmark({ ...opts, topK: Number(opts.topK), maxContextTokens: Number(opts.maxContextTokens), limit: 0, offset: 0, shardIndex: 0, shardCount: 1, temperature: 0, retries: 1, maxLiveCalls: 10, arm: 'iteration' }, hooks as ProductHooks);
      // Passthrough reached the product process:
      expect(captured[0].RENOR_TYPED_FACTS).toBe('1');
      // Manifest records the armed flag:
      expect(overridesOf(manifest)).toContain('RENOR_TYPED_FACTS=1');
      // The arm flag is a separate opt-in. Unset means these four stay off
      // even when this test has armed one flag through the env passthrough.
      expect(captured[0].RENOR_CHRONICLE).toBeUndefined();
    } finally {
      if (prevTyped === undefined) delete process.env.RENOR_TYPED_FACTS;
      else process.env.RENOR_TYPED_FACTS = prevTyped;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('arms and records all four structured-row flags only when --structured-rows is set', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'renor-structured-arm-'));
    const captured: Array<Record<string, string>> = [];
    const hooks: Partial<ProductHooks> = {
      publicSearch: async (args) => {
        captured.push({ ...args.env });
        return {
          hits: [{ notePath: path.join(args.vaultDir, 'Sessions', 'a-1.md'), text: 'alpha body', score: 0.9 }],
          transport: 'test',
          command: 'test',
          durationMs: 1,
        };
      },
      models: {
        modelCall: async () => ({
          rawContent: '1',
          modelEcho: 'stub',
          finishReason: 'stop',
          latencyMs: 1,
          promptTokens: 1,
          completionTokens: 1,
        }),
        sentinel: async () => undefined,
      },
    };
    const datasetPath = path.join(root, 'ds.json');
    fs.writeFileSync(datasetPath, JSON.stringify([{
      question_id: 'arm-1',
      question: 'What business did the user study?',
      question_date: '2023/05/30 (Tue) 23:40',
      answer: 'Business Administration',
      answer_session_ids: ['s1'],
      question_type: 'single-session-user',
      haystack_session_ids: ['s1'],
      haystack_sessions: [[{ role: 'user', content: 'I study business administration.' }]],
      haystack_dates: ['2023/05/01'],
    }]));
    const prevKey = process.env.RENOR_EXTRACTOR_API_KEY;
    process.env.RENOR_EXTRACTOR_API_KEY = 'dedicated-test-key';
    const parentFlags = ['RENOR_TYPED_FACTS', 'RENOR_CHRONICLE', 'RENOR_PREFS', 'RENOR_STRUCTURED_CONTEXT'] as const;
    const prevFlags = Object.fromEntries(parentFlags.map(name => [name, process.env[name]]));
    for (const name of parentFlags) process.env[name] = '0';
    try {
      const base = [
        '--dataset', datasetPath,
        '--output', path.join(root, 'out'),
        '--embedding-provider', 'eval-hash',
        '--transport-smoke',
        '--limit', '0',
        '--shard-index', '0',
        '--shard-count', '1',
        '--max-live-calls', '10',
        '--no-cache',
      ];
      const armed = parseProductArgs([...base, '--structured-rows']);
      const { manifest } = await runProductBenchmark(
        { ...armed, topK: Number(armed.topK), maxContextTokens: Number(armed.maxContextTokens), limit: 0, offset: 0, shardIndex: 0, shardCount: 1, temperature: 0, retries: 1, maxLiveCalls: 10, arm: 'iteration', structuredRows: true },
        hooks as ProductHooks,
      );
      for (const name of parentFlags) {
        // Parent shell says 0. The explicit arm still wins, in the child and
        // in the manifest.
        expect(captured[0][name]).toBe('1');
        expect(overridesOf(manifest)).toContain(`${name}=1`);
      }
      // The dedicated extractor slot reaches the child. Its value does not
      // reach the manifest.
      expect(captured[0].RENOR_EXTRACTOR_API_KEY).toBe('dedicated-test-key');
      expect(JSON.stringify(overridesOf(manifest))).not.toContain('dedicated-test-key');

      const before = captured.length;
      const plain = parseProductArgs([
        ...base.map(arg => arg === path.join(root, 'out') ? path.join(root, 'out-off') : arg),
      ]);
      const unarmed = await runProductBenchmark(
        { ...plain, topK: Number(plain.topK), maxContextTokens: Number(plain.maxContextTokens), limit: 1, offset: 0, shardIndex: 0, shardCount: 1, temperature: 0, retries: 1, maxLiveCalls: 10, arm: 'iteration' },
        hooks as ProductHooks,
      );
      expect(captured.length).toBeGreaterThan(before);
      const child = captured[captured.length - 1];
      for (const name of parentFlags) expect(child[name]).toBe('0');
      const recorded = overridesOf(unarmed.manifest).join('\n');
      expect(recorded).not.toContain('RENOR_TYPED_FACTS=1');
      expect(recorded).toContain('RENOR_TYPED_FACTS=0');
    } finally {
      if (prevKey === undefined) delete process.env.RENOR_EXTRACTOR_API_KEY;
      else process.env.RENOR_EXTRACTOR_API_KEY = prevKey;
      for (const name of parentFlags) {
        if (prevFlags[name] === undefined) delete process.env[name];
        else process.env[name] = prevFlags[name];
      }
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});