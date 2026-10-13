import { describe, it, expect, vi } from 'vitest';
import {
  contentDateFromFrontmatter,
  extractNumericFacts,
  extractNumericFactsWithRetry,
  ExtractorParseError,
  FACTS_EXTRACTION_VERSION,
  FACTS_MODEL,
  MAX_EXTRACT_ATTEMPTS,
  typedFactsEnabled,
} from '../../src/extraction/typedFacts';

function llm(content: string) {
  return { chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } } };
}

describe('C2 extractor unit contract', () => {
  it('uses the frozen v1 model gemma4:31b and requests strict JSON', async () => {
    const client = llm('{"facts":[]}');
    await extractNumericFacts(client as any, 'T', 'body');
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: FACTS_MODEL, temperature: 0, response_format: { type: 'json_object' } }),
    );
    expect(FACTS_EXTRACTION_VERSION).toContain('facts-v1');
    expect(FACTS_EXTRACTION_VERSION).toContain(FACTS_MODEL);
  });

  it('parses a valid JSON response into typed numeric facts', async () => {
    const client = llm(JSON.stringify({
      facts: [
        { value: '42.195', unit: 'km', verb: 'ran', object: 'marathon distance', event: 'race day' },
        { value: '3:45', object: 'marathon time' },
        { value: '', object: 'missing value' },
        { value: '10', object: '' },
        { object: 'no value at all' },
      ],
    }));
    const facts = await extractNumericFacts(client as any, 'T', 'body');
    expect(facts).toHaveLength(2);
    expect(facts[0]).toEqual({ value: '42.195', unit: 'km', verb: 'ran', object: 'marathon distance', event: 'race day' });
    expect(facts[1]).toEqual({ value: '3:45', object: 'marathon time' });
  });

  it('YAML response → explicit extractor-parse-error, retried ≤3 total, never silent []', async () => {
    const client = llm('facts:\n  - value: 42\n    object: answer\n');
    const extract = () => extractNumericFacts(client as any, 'T', 'body');
    await expect(extractNumericFactsWithRetry(extract, 'T', 'body'))
      .rejects.toThrow(ExtractorParseError);
    await expect(extractNumericFactsWithRetry(extract, 'T', 'body'))
      .rejects.toThrow(/extractor-parse-error/);
    // ≤3 attempts: the model was called exactly MAX_EXTRACT_ATTEMPTS times per retry run.
    expect(client.chat.completions.create).toHaveBeenCalledTimes(6);
    expect(MAX_EXTRACT_ATTEMPTS).toBe(3);
  });

  it('succeeds on the last attempt after transient parse failures', async () => {
    let calls = 0;
    const facts = await extractNumericFactsWithRetry(async () => {
      calls++;
      if (calls < 3) throw new ExtractorParseError('extractor-parse-error: transient');
      return [{ value: '5', object: 'km' }];
    }, 'T', 'body');
    expect(calls).toBe(3);
    expect(facts).toEqual([{ value: '5', object: 'km' }]);
  });

  it('propagates non-parse errors immediately (no retry burn)', async () => {
    const boom = async () => { throw new Error('network down'); };
    await expect(extractNumericFactsWithRetry(boom, 'T', 'body')).rejects.toThrow('network down');
  });

  it('RENOR_TYPED_FACTS is default OFF and no default was flipped', () => {
    expect(typedFactsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(typedFactsEnabled({ RENOR_TYPED_FACTS: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(typedFactsEnabled({ RENOR_TYPED_FACTS: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(typedFactsEnabled({ RENOR_TYPED_FACTS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('fenced JSON response (gemma4 markdown code fence) parses — fence-strip before JSON.parse', async () => {
    const client = llm('```json\n{"facts":[{"value":"7","object":"hills"}]}\n```');
    const facts = await extractNumericFacts(client as any, 'T', 'body');
    expect(facts).toEqual([{ value: '7', object: 'hills' }]);
  });

  it('fence-strip stays JSON-strict: fenced YAML and truncated JSON still fail hard', async () => {
    const fencedYaml = llm('```json\nfacts:\n  - value: 42\n```');
    await expect(extractNumericFacts(fencedYaml as any, 'T', 'body')).rejects.toThrow(ExtractorParseError);
    const truncated = llm('```json\n{"facts":[{"value":"7"');
    await expect(extractNumericFacts(truncated as any, 'T', 'body')).rejects.toThrow(ExtractorParseError);
    const bareYaml = llm('facts:\n  - value: 42\n');
    await expect(extractNumericFacts(bareYaml as any, 'T', 'body')).rejects.toThrow(ExtractorParseError);
    const commentary = llm('Here are the facts:\n{"facts":[]}');
    await expect(extractNumericFacts(commentary as any, 'T', 'body')).rejects.toThrow(ExtractorParseError);
  });
});

describe('content date for valid_from (ADR §4: unknown stays unknown)', () => {
  it('prefers session_date, then date, from frontmatter', () => {
    expect(contentDateFromFrontmatter({ session_date: '2026-03-15' })).toBe('2026-03-15');
    expect(contentDateFromFrontmatter({ date: '2026-03-15T10:00:00Z' })).toBe('2026-03-15');
    expect(contentDateFromFrontmatter({ session_date: '2026-03-15', date: '2026-01-01' })).toBe('2026-03-15');
    expect(contentDateFromFrontmatter({ date: 'March 15, 2026' })).toMatch(/2026-03-1[45]/);
  });

  it('frontmatter without a date → NULL (never now(), never invented)', () => {
    expect(contentDateFromFrontmatter({})).toBeNull();
    expect(contentDateFromFrontmatter({ title: 'x' })).toBeNull();
  });

  it('unparsable date strings stay NULL — never fabricated', () => {
    expect(contentDateFromFrontmatter({ session_date: 'not-a-date' })).toBeNull();
    expect(contentDateFromFrontmatter({ date: '???' })).toBeNull();
    expect(contentDateFromFrontmatter({ date: '   ' })).toBeNull();
  });
});