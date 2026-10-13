import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  parseConversation,
  encodeProjectPath,
  resolveJSONLPath,
} from "../../src/conversation/parser";

const FIXTURE = path.join(process.cwd(), "fixtures/conversation/sample.jsonl");
const SESSION_ID = "test-session-001";
const CWD = "/Users/test/project";

describe("encodeProjectPath", () => {
  it("replaces slashes with dashes", () => {
    expect(encodeProjectPath("/Users/example/project")).toBe(
      "-Users-example-project",
    );
  });
  it("handles paths without leading slash", () => {
    expect(encodeProjectPath("Users/foo")).toBe("Users-foo");
  });
});

describe("resolveJSONLPath", () => {
  it("builds correct path", () => {
    const result = resolveJSONLPath("abc-123", "/Users/example/project");
    expect(result).toContain("-Users-example-project");
    expect(result).toContain("abc-123.jsonl");
    expect(result).toContain(".claude/projects");
  });
});

/**
 * A fixture directory per process, never a fixed name under the temp root. Two vitest workers
 * running this file — and, more importantly, two independent suite runs on one host — must not
 * write each other's JSONL out from under the parser: the second run's `rm` lands between the
 * first run's write and parse, and the parse of a file that is no longer there is a flake rather
 * than a failure. `mkdtemp` appends six random characters, so each process gets its own directory.
 */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "conv-parser-"));

afterEach(() => {
  for (const entry of fs.readdirSync(TMP_ROOT)) fs.rmSync(path.join(TMP_ROOT, entry), { force: true });
});

function fixtureFile(name: string): string {
  return path.join(TMP_ROOT, name);
}

describe("parseConversation", () => {
  it("extracts title from ai-title entry", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    expect(result.title).toBe("Fix auth bug");
  });

  it("extracts timeStart from first queue dequeue", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    expect(result.timeStart).toBe("2026-04-03T10:30:00.000Z");
  });

  it("extracts session_id and project", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.project).toBe(CWD);
  });

  it("includes real user messages", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    const userTurns = result.turns.filter((t) => t.role === "user");
    expect(userTurns.map((t) => t.text)).toContain(
      "Please fix the authentication bug",
    );
    expect(userTurns.map((t) => t.text)).toContain("Thanks!");
  });

  it("skips tool_result-only user messages", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    const userTexts = result.turns
      .filter((t) => t.role === "user")
      .map((t) => t.text);
    expect(userTexts).not.toContain("File edited successfully");
  });

  it("skips meta user messages", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    const userTexts = result.turns
      .filter((t) => t.role === "user")
      .map((t) => t.text);
    expect(userTexts).not.toContain("internal meta");
  });

  it("skips local-command user messages", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    const userTexts = result.turns
      .filter((t) => t.role === "user")
      .map((t) => t.text);
    expect(userTexts.some((t) => t.includes("<local-command"))).toBe(false);
  });

  it("extracts assistant text", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    expect(assistantTurns[0].text).toBe("I'll fix it now.");
  });

  it("extracts Edit tool call with diff", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const editCall = assistantTurns[0].toolCalls.find(
      (tc) => tc.kind === "edit",
    );
    expect(editCall).toBeDefined();
    expect((editCall as any).filePath).toBe("src/auth.ts");
    expect((editCall as any).oldString).toBe("return false;");
    expect((editCall as any).newString).toBe("return true;");
  });

  it("extracts Bash tool call", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const bashCall = assistantTurns[1].toolCalls.find(
      (tc) => tc.kind === "bash",
    );
    expect(bashCall).toBeDefined();
    expect((bashCall as any).command).toBe("npm test");
  });

  it("extracts Write tool call with only file path", async () => {
    const result = await parseConversation(FIXTURE, SESSION_ID, CWD);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const writeCall = assistantTurns[2].toolCalls.find(
      (tc) => tc.kind === "write",
    );
    expect(writeCall).toBeDefined();
    expect((writeCall as any).filePath).toBe("CHANGELOG.md");
  });

  it("uses session_id as fallback title when ai-title missing", async () => {
    const tmp = fixtureFile("no-title.jsonl");
    await fs.promises.writeFile(
      tmp,
      '{"type":"queue-operation","operation":"dequeue","timestamp":"2026-04-03T10:00:00.000Z"}\n{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"uuid":"x","isMeta":false}\n',
      "utf8",
    );
    const result = await parseConversation(tmp, "fallback-id", "/test", { maxRetries: 0 });
    expect(result.title).toBe("fallback-id");
  });

  it("skips sidechain messages", async () => {
    const tmp = fixtureFile("sidechain.jsonl");
    await fs.promises.writeFile(
      tmp,
      '{"type":"queue-operation","operation":"dequeue","timestamp":"2026-04-03T10:00:00.000Z"}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Real message"}]},"uuid":"x","isMeta":false,"isSidechain":false}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Sidechain message"}]},"uuid":"y","isMeta":false,"isSidechain":true}\n',
      "utf8",
    );
    const result = await parseConversation(tmp, "test-id", "/test", { maxRetries: 0 });
    const userTexts = result.turns
      .filter((t) => t.role === "user")
      .map((t) => t.text);
    expect(userTexts).toContain("Real message");
    expect(userTexts).not.toContain("Sidechain message");
  });
});
