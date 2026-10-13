import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/mcp/server';
import { ownerNames } from '../../src/retrieval/queryHelpers';

// Tool descriptions are read by every connected agent, so they must not carry the owner's name or personal topics.
describe('stdio tool descriptions are neutral', () => {
  it('no shipped tool description names the configured owner', () => {
    const owners = ownerNames();
    expect(owners.length).toBeGreaterThan(0);
    for (const tool of TOOLS) {
      for (const owner of owners) {
        expect(tool.description, `${tool.name} description`).not.toContain(owner);
      }
    }
  });
});
