import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sanitizeErrorMessage, toolError, createMvpApp } from '../../src/mvp/server';
import { escapeInvisibleControls } from '../../src/mvp/sanitize';
import { loadMvpConfig, type MvpConfig } from '../../src/mvp/config';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { attachEngine } from '../../src/mvp/engine';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.chmodSync(d, 0o755);
    } catch {
      // ignore
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeTestConfig(memoryDir: string): MvpConfig {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-auth-test-'));
  tmpDirs.push(authRoot);
  process.env.MVP_MEMORY_DIR = memoryDir;
  process.env.MVP_AUTH_STATE_PATH = path.join(authRoot, 'clients.json');
  process.env.MVP_BASE_URL = 'http://127.0.0.1:3000';
  process.env.MVP_OWNER_EMAIL = 'owner@example.test';
  process.env.MVP_OWNER_PASSWORD = 'password-123';
  process.env.MVP_PORT = '3000';
  process.env.MVP_ALLOWED_CALLBACK_URIS = 'http://127.0.0.1:1/callback';
  return loadMvpConfig();
}

describe('HYP-20260918-tool-errors-leak-host-paths: Privacy-safe tool errors', () => {
  it('sanitizeErrorMessage redacts Unix and Windows absolute paths', () => {
    const unixErr = new Error("EACCES: permission denied, open '/home/user/obsidian-vault/Memory/Daily.md'");
    expect(sanitizeErrorMessage(unixErr)).toBe("EACCES: permission denied, open [redacted-path]");

    const winErr = new Error("Failed to open 'C:\\Users\\User\\vault\\Daily.md': locked");
    expect(sanitizeErrorMessage(winErr)).toBe("Failed to open [redacted-path]: locked");

    const genericErr = new Error("Failed at /var/data/private/secret.txt with error");
    expect(sanitizeErrorMessage(genericErr)).toBe("Failed at [redacted-path] with error");

    // Preserves non-path numbers and expressions
    const normalErr = new Error("Validation failed: ratio 1/2 is invalid");
    expect(sanitizeErrorMessage(normalErr)).toBe("Validation failed: ratio 1/2 is invalid");
  });

  it('sanitizeErrorMessage redacts err.path if present on ErrnoException', () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory, open '/custom/path/to/ledger.md'");
    err.path = '/custom/path/to/ledger.md';
    err.code = 'ENOENT';
    const sanitized = sanitizeErrorMessage(err);
    expect(sanitized).not.toContain('/custom/path/to/ledger.md');
    expect(sanitized).toContain('[redacted-path]');
  });

  it('toolError returns bounded isError payload without leaking host path', () => {
    const err = new Error("EISDIR: illegal operation on a directory, read '/home/example/renor/vault'");
    const res = toolError(err);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain('/home/example/renor/vault');
    expect(res.content[0].text).toContain('[redacted-path]');
    expect(res.content[0].text).toContain('EISDIR: illegal operation on a directory, read');
  });

  it('escapeInvisibleControls escapes hidden/bidi/line controls on the wire and decodes losslessly', () => {
    const payload = 'a\u202eb\u200bc\u2066d\u2069e\ufefff\u2028g\u2029h\u0085i\u{E0041}j';
    const out = escapeInvisibleControls(JSON.stringify({ text: payload }));
    // No raw Cc/Cf/Zl/Zp survives: an agent or a log reads the escape, not the applied character.
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(out)).toBe(false);
    expect(out).toContain('\\u202e');
    expect(out).toContain('\\u2028');
    // The escape is wire-only: any JSON parser reads the exact stored string back.
    expect(JSON.parse(out).text).toBe(payload);
    // Ordinary text (including astral characters and CJK) is untouched.
    const normal = JSON.stringify({ text: 'normal 😀 東京 — text' });
    expect(escapeInvisibleControls(normal)).toBe(normal);
  });

  it('filesystem-backed MCP tool failure (export_memory on unreadable file) redacts absolute host path', async ({ skip }) => {
    if (process.getuid?.() === 0) skip('requires a non-root process so file permissions deny reads');
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-secret-host-dir-'));
    tmpDirs.push(memoryDir);

    const config = makeTestConfig(memoryDir);
    const mvp = createMvpApp(config);
    const ledgerFile = path.join(memoryDir, config.ledgerRelPath);
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, '# secret content\n', { mode: 0o000 });

    try {
      const server = mvp.server;

      // Invoke export_memory tool handler
      const tools = (server as any)._registeredTools;
      const exportTool = tools?.['export_memory'];
      expect(exportTool).toBeDefined();

      const result = await exportTool.handler({});
      expect(result.isError).toBe(true);

      const errorText = result.content[0].text;
      // MUST NOT contain the absolute host path or temp dir name
      expect(errorText).not.toContain(memoryDir);
      expect(errorText).not.toContain('mvp-secret-host-dir-');
      expect(errorText).not.toContain(ledgerFile);
      // MUST contain actionable error description and redacted path marker
      expect(errorText).toContain('[redacted-path]');
      expect(errorText).toMatch(/EACCES: permission denied/);
    } finally {
      try {
        fs.chmodSync(ledgerFile, 0o644);
      } catch {
        // ignore
      }
      await mvp.close();
    }
  });
});
