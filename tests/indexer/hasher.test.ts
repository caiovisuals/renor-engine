import { describe, it, expect } from 'vitest';
import { hashContent } from '../../src/indexer/hasher';

describe('hashContent', () => {
  it('is stable', () => {
    expect(hashContent('hi')).toBe(hashContent('hi'));
  });

  it('differs for different input', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });

  it('returns 64-char hex', () => {
    expect(hashContent('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
