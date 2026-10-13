import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { writeConversation } from "../../src/conversation/writer";
import type { ParsedConversation } from "../../src/conversation/types";

const SAMPLE: ParsedConversation = {
  sessionId: "abc-123",
  title: "Fix auth bug",
  timeStart: "2026-04-03T10:30:00.000Z",
  project: "/Users/test/project",
  turns: [{ role: "user", text: "Please fix it", toolCalls: [] }],
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeConversation", () => {
  it("creates conversations dir if missing", async () => {
    await writeConversation(tmp, "Claude Code/Conversations", SAMPLE);
    expect(fs.existsSync(path.join(tmp, "Claude Code", "Conversations"))).toBe(
      true,
    );
  });

  it("creates file with correct name", async () => {
    const filePath = await writeConversation(
      tmp,
      "Claude Code/Conversations",
      SAMPLE,
    );
    expect(path.basename(filePath)).toBe("2026-04-03 10-30 - Fix auth bug.md");
  });

  it("returns absolute path to created file", async () => {
    const filePath = await writeConversation(
      tmp,
      "Claude Code/Conversations",
      SAMPLE,
    );
    expect(path.isAbsolute(filePath)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("file content includes kind: conversation frontmatter", async () => {
    const filePath = await writeConversation(
      tmp,
      "Claude Code/Conversations",
      SAMPLE,
    );
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("kind: conversation");
    expect(content).toContain('title: "Fix auth bug"');
  });

  it("file content includes user turn", async () => {
    const filePath = await writeConversation(
      tmp,
      "Claude Code/Conversations",
      SAMPLE,
    );
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("**User:** Please fix it");
  });
});
