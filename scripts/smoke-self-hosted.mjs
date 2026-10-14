#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The server is started from dist/cli.js relative to the working directory, so the script must run from the engine root.
if (!fs.existsSync(path.resolve('dist/cli.js')) || !fs.existsSync(path.resolve('package.json'))) {
  console.error('Run this from the engine/ directory (cd engine && node scripts/smoke-self-hosted.mjs), after npm run build.');
  process.exit(1);
}

const vault = process.env.VAULT_PATH;
if (!vault || !path.isAbsolute(vault)) {
  console.error('VAULT_PATH must be an absolute path. Follow README.md section 2 first.');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/cli.js'), 'mcp'],
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH ?? '',
    VAULT_PATH: vault,
    EMBEDDING_PROVIDER: 'eval-hash',
    RENOR_EVIDENCE_MODE: 'off',
    RENOR_TELEMETRY_DISABLED: 'true',
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'renor-self-hosted-smoke', version: '1.0.0' });

function body(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP tool returned an error');
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('MCP tool returned no text result');
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const required of ['remember_fact', 'search']) {
    if (!names.includes(required)) throw new Error(`tools/list did not include ${required}`);
  }
  console.log(`tools/list: ${names.join(', ')}`);

  body(await client.callTool({
    name: 'remember_fact',
    arguments: { subject: 'Ada', predicate: 'favorite_color', object: 'cerulean' },
  }));
  console.log('remember_fact: saved Ada favorite_color cerulean');

  for (const query of ["What is Ada's favorite color?", 'Ada favorite color cerulean', 'cerulean']) {
    const result = body(await client.callTool({ name: 'search', arguments: { query } }));
    if (!JSON.stringify(result).toLowerCase().includes('cerulean')) {
      throw new Error(`search did not return cerulean for ${JSON.stringify(query)}: ${JSON.stringify(result)}`);
    }
    console.log(`search: ${JSON.stringify(query)} -> cerulean`);
  }
  console.log('PASS: self-hosted stdio MCP can remember and retrieve a current fact.');
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => transport.close());
}
