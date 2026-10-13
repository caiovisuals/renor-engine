import { describe, it, expect } from 'vitest';
import { TOOLS } from '../../src/mcp/server';

/**
 * The local stdio MCP server's tools say what a `source` is (independent review of PR 388, finding P3):
 * an author is who the CONNECTION says, never what the client typed, and never a file path. Both
 * tools write through the one cleaner, so what is stored was already right; this is the text an
 * agent reads before it chooses what to send. Since the hive hardening a typed `source` is ignored
 * outright: an unnamed stdio connection cannot write as another agent.
 */
describe('the local MCP tools describe source as the connection, not a choice', () => {
  it.each(['remember_fact', 'note'])('%s', (name) => {
    const tool = TOOLS.find((t) => t.name === name);
    expect(tool, name).toBeDefined();
    const description = (tool!.inputSchema as any).properties.source.description as string;
    expect(description).toMatch(/Ignored/);
    expect(description).toMatch(/header-form name/);
    expect(description).toMatch(/Never a file path or document name/);
  });
});
