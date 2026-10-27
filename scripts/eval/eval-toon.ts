import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Command } from 'commander';
import { encode as oracle } from 'gpt-tokenizer';
import { renderToon, TOON_HEADER } from '../../src/mvp/toonResponse';
import { escapeInvisibleControls } from '../../src/mvp/sanitize';
import { encodeTokens as tokens } from '../../src/indexer/tokenizer';

interface Capture {
  tool: string;
  arguments?: Record<string, unknown>;
  result: { content: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
}
interface Case { id: string; group: string; capture: Capture; served?: Capture }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Reply-shaped synthetic controls, not retrieval-quality examples or a production traffic distribution. */
function syntheticCases(): Case[] {
  const cases: Case[] = [];
  const add = (id: string, group: string, body: unknown) => {
    for (const structured of [false, true]) {
      cases.push({ id: `${id}/${structured ? 'structured' : 'text'}`, group: `${group}/${structured ? 'structured' : 'text'}`, capture: {
        tool: 'search_memory', result: {
          content: [{ type: 'text', text: escapeInvisibleControls(JSON.stringify(body)) }],
          ...(structured ? { structuredContent: body } : {}),
        },
      } });
    }
  };
  const paragraph = 'The Orion runbook records the reason for each change. Read the previous decision before replacing it. '
    + 'A rollback restores the last verified configuration and records which evidence justified the decision. '
    + 'This synthetic note contains no credentials or customer information.';
  const code = '```ts\nconst columns = ["name", "reason"];\nconst path = "C:\\\\notes";\n```\n\n';
  for (const n of [1, 6, 24]) {
    for (const multiline of [false, true]) {
      for (const mixed of [false, true]) {
        const prose = Array.from({ length: 12 }, () => paragraph).join(multiline ? '\n\n' : ' ')
          + (multiline ? `\n\n${code}Line with a comma, quotes "x", a tab\tand café 東京.` : '');
        add(`prose-${n}-${multiline}-${mixed}`, `prose-${multiline ? 'multiline' : 'paragraph'}-${mixed ? 'mixed' : 'uniform'}`, {
          ok: true,
          hits: Array.from({ length: n }, (_, i) => ({
            notePath: `Imported/runbook-${i}.md`, text: prose, score: i / (n + 1), reason: 'semantic',
            ...(!mixed || i % 2 === 0 ? { headingPath: 'Orion runbook', session_date: '2026-10-27' } : {}),
            ...(mixed && i === 0 ? { untrusted: true, origin: 'import', replaced: { by: 'synthetic-correction', source: 'test-agent', at: '2026-10-27' } } : {}),
          })),
        });
      }
    }
  }
  add('uniform-short', 'uniform-short', { ok: true, hits: Array.from({ length: 24 }, (_, i) => ({ notePath: `note-${i}.md`, text: `Orion component ${i}`, score: 0.5, reason: 'semantic' })) });
  add('empty', 'empty', { ok: true, hits: [] });
  add('bmp-controls', 'controls', { ok: true, hits: [{ text: 'Orion \u202e\u200d\ufe0f\u0085\u2028\u034f \b\f\u0000 \\u202e 🐱' }] });
  add('astral-invisible', 'unsupported', { ok: true, hits: [{ text: 'Orion \u{E0100}' }] });
  add('lone-surrogate', 'unsupported', { ok: true, hits: [{ text: 'Orion \ud800' }] });
  return cases;
}

async function main(): Promise<void> {
  const opts = new Command()
    .description('Offline fixed-TOON comparison on identical MCP reply values; no model or network')
    .option('--capture <file>', 'RenorBench --capture-replies JSONL, repeatable', (value, old: string[]) => [...old, value], [])
    .option('--toon-capture <file>', 'matching TOON-profile captures, in the same order as --capture', (value, old: string[]) => [...old, value], [])
    .requiredOption('--output <file>', 'new JSON report (will not overwrite)')
    .parse().opts<{ capture: string[]; toonCapture: string[]; output: string }>();
  const { decode } = await import('@toon-format/toon');
  const cases = syntheticCases();
  const inputs: Array<{ name: string; sha256: string }> = [];
  assert(opts.toonCapture.length === 0 || opts.toonCapture.length === opts.capture.length, 'supply one TOON capture per JSON capture');
  for (const [fileIndex, file] of opts.capture.entries()) {
    const raw = fs.readFileSync(file, 'utf8');
    const name = path.basename(path.dirname(file));
    inputs.push({ name, sha256: hash(raw) });
    const lines = raw.trim().split('\n');
    const pairedRaw = opts.toonCapture[fileIndex] ? fs.readFileSync(opts.toonCapture[fileIndex], 'utf8') : undefined;
    const paired: Capture[] | undefined = pairedRaw?.trim().split('\n').map(line => JSON.parse(line));
    if (paired) {
      inputs.push({ name: `${name}/toon`, sha256: hash(pairedRaw!) });
      assert.equal(paired.length, lines.length, 'capture call counts differ');
    }
    let capturedSearches = 0;
    for (const [i, line] of lines.entries()) {
      const capture = JSON.parse(line) as Capture;
      const served = paired?.[i];
      if (served) {
        assert.equal(served.tool, capture.tool);
        assert.deepEqual(served.arguments, capture.arguments);
      }
      if (['search_memory', 'get_context'].includes(capture.tool) && !capture.result.isError) {
        if (capture.tool === 'search_memory') capturedSearches++;
        cases.push({ id: `${name}/${i}`, group: `${name}/${capture.tool}`, capture, served });
      }
    }
    assert(capturedSearches > 0, `no successful search replies captured in ${name}`);
  }
  // Positive round trip and deliberately corrupted data: the integrity oracle must reject a changed value.
  const control = { ok: true, hits: [{ text: 'control' }] };
  assert.deepEqual(decode((await renderToon(JSON.stringify(control))).slice(TOON_HEADER.length)), control);
  assert.throws(() => assert.deepEqual({ ...control, hits: [] }, control));
  const samples: Array<Record<string, string | number | boolean | null>> = [];
  let pairedSearchReplies = 0;
  let unchangedContextReplies = 0;
  for (const item of cases) {
    const { result } = item.capture;
    const json = result.content[0]?.text;
    assert.equal(result.content[0]?.type, 'text');
    assert.equal(typeof json, 'string');
    const original = json!;
    const body: unknown = JSON.parse(original);
    let toon: string;
    try { toon = await renderToon(original); }
    catch {
      if (item.served && item.capture.tool === 'search_memory') {
        assert.equal(item.served.result.isError, true, item.id);
        assert.equal(JSON.parse(item.served.result.content[0].text!).error, 'toon-encoding-unsupported', item.id);
      }
      samples.push({ id: item.id, group: item.group, unsupported: true, jsonTokens: tokens(original) });
      continue;
    }
    assert.deepEqual(decode(toon.slice(TOON_HEADER.length)), body, item.id);
    const candidate = { ...result, content: [{ ...result.content[0], text: toon }, ...result.content.slice(1)] };
    assert.deepEqual(candidate.structuredContent, result.structuredContent);
    if (item.served) {
      if (item.capture.tool === 'search_memory') {
        assert.deepEqual(item.served.result, candidate, `served TOON differs: ${item.id}`);
        pairedSearchReplies++;
      } else {
        assert.deepEqual(item.served.result, result, `get_context changed: ${item.id}`);
        unchangedContextReplies++;
      }
    }
    for (const text of [original, toon, JSON.stringify(result), JSON.stringify(candidate)]) {
      assert.equal(tokens(text), oracle(text, { disallowedSpecial: new Set() }).length, `counter mismatch: ${item.id}`);
    }
    const jsonTimes: number[] = [];
    const toonTimes: number[] = [];
    // Warm module; serialization-only wall time, excluding retrieval and model latency. No performance assertion.
    for (let repeat = 0; repeat < 5; repeat++) {
      let start = performance.now();
      escapeInvisibleControls(JSON.stringify(body));
      jsonTimes.push(performance.now() - start);
      start = performance.now();
      await renderToon(original);
      toonTimes.push(performance.now() - start);
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const budget = item.capture.tool === 'get_context' ? Number(item.capture.arguments?.max_tokens ?? 800) : null;
    samples.push({ id: item.id, group: item.group, unsupported: false,
      jsonTokens: tokens(original), toonTokens: tokens(toon),
      jsonResultTokens: tokens(JSON.stringify(result)), toonResultTokens: tokens(JSON.stringify(candidate)),
      jsonBytes: Buffer.byteLength(original), toonBytes: Buffer.byteLength(toon),
      jsonSerializeMs: median(jsonTimes), toonFromJsonMs: median(toonTimes),
      bodySha256: hash(JSON.stringify(body)), budget,
      // get_context is measured only; the product profile leaves it JSON.
      toonExceedsContextBudget: budget !== null && tokens(toon) > budget,
    });
  }
  assert(samples.some(s => s.unsupported === false && Number(s.toonTokens) < Number(s.jsonTokens)), 'missing saving control');
  assert(samples.some(s => s.unsupported === false && Number(s.toonTokens) > Number(s.jsonTokens)), 'missing regression control');
  assert(samples.some(s => s.unsupported === true), 'missing unsupported control');
  const groups = [...new Set(samples.map(s => String(s.group)))].map(group => {
    const all = samples.filter(s => s.group === group);
    const valid = all.filter(s => !s.unsupported);
    const sum = (key: string) => valid.reduce((n, s) => n + Number(s[key]), 0);
    return { group, replies: all.length, encoded: valid.length, unsupported: all.length - valid.length,
      jsonTokens: sum('jsonTokens'), toonTokens: sum('toonTokens'),
      jsonResultTokens: sum('jsonResultTokens'), toonResultTokens: sum('toonResultTokens'),
      jsonBytes: sum('jsonBytes'), toonBytes: sum('toonBytes'),
      largerReplies: valid.filter(s => Number(s.toonTokens) > Number(s.jsonTokens)).length,
      contextBudgetOverruns: valid.filter(s => s.toonExceedsContextBudget).length,
      sumMedianJsonSerializeMs: sum('jsonSerializeMs'), sumMedianToonFromJsonMs: sum('toonFromJsonMs'),
    };
  });
  const report = { date: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
    encoder: '@toon-format/toon 4.4.0', header: TOON_HEADER, inputs, pairedSearchReplies, unchangedContextReplies,
    sourceSha256: Object.fromEntries(['src/mvp/toonResponse.ts', 'src/mvp/contextProfile.ts', 'src/mvp/server.ts',
      'scripts/eval/eval-toon.ts', 'scripts/eval/run-renorbench-product.ts', 'package-lock.json']
      .map(file => [file, hash(fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8'))])),
    encoderSha256: hash(fs.readFileSync(require.resolve('@toon-format/toon'), 'utf8')),
    caveats: ['Synthetic cases are reply-shaped, not production frequency or retrieval quality.',
      'get_context conversion is comparison-only; the product keeps it JSON.',
      'Only successfully encoded pairs contribute to token totals; unsupported replies are counted separately.',
      'Full-result tokens describe serialized MCP JSON, not client/model usage.',
      'Timings are warm serialization-only wall time. Bytes are materialized text sizes, not peak heap/RSS.'],
    groups, samples };
  fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
  fs.writeFileSync(opts.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: opts.output, groups }, null, 2));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
