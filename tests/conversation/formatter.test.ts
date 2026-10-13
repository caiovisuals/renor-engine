import { describe, it, expect } from "vitest";
import {
  formatConversation,
  buildFilename,
} from "../../src/conversation/formatter";
import type { ParsedConversation } from "../../src/conversation/types";

const SAMPLE: ParsedConversation = {
  sessionId: "abc-123",
  title: "Fix auth bug",
  timeStart: "2026-04-03T10:30:00.000Z",
  project: "/Users/example/project",
  turns: [
    { role: "user", text: "Please fix the bug", toolCalls: [] },
    {
      role: "assistant",
      text: "I'll fix it.",
      toolCalls: [
        {
          kind: "edit",
          filePath: "src/auth.ts",
          oldString: "return false;",
          newString: "return true;",
        },
      ],
    },
    {
      role: "assistant",
      text: "Running tests.",
      toolCalls: [{ kind: "bash", command: "npm test" }],
    },
    {
      role: "assistant",
      text: "Creating file.",
      toolCalls: [{ kind: "write", filePath: "CHANGELOG.md" }],
    },
    { role: "user", text: "Thanks!", toolCalls: [] },
  ],
};

describe("buildFilename", () => {
  it("formats as YYYY-MM-DD HH-mm - title.md", () => {
    expect(buildFilename("Fix auth bug", "2026-04-03T10:30:00.000Z")).toBe(
      "2026-04-03 10-30 - Fix auth bug.md",
    );
  });
  it("sanitizes slashes in title", () => {
    expect(
      buildFilename("feat/auth fix", "2026-04-03T10:30:00.000Z"),
    ).not.toContain("/");
  });
  it("sanitizes colons in title", () => {
    expect(
      buildFilename("fix: auth bug", "2026-04-03T10:30:00.000Z"),
    ).not.toContain(":");
  });
});

describe("formatConversation", () => {
  it("includes kind: conversation in frontmatter", () => {
    expect(formatConversation(SAMPLE)).toContain("kind: conversation");
  });
  it("includes date in frontmatter", () => {
    expect(formatConversation(SAMPLE)).toContain("date: 2026-04-03");
  });
  it("includes time_start in frontmatter", () => {
    expect(formatConversation(SAMPLE)).toContain("time_start: 10:30");
  });
  it("includes session_id in frontmatter", () => {
    expect(formatConversation(SAMPLE)).toContain("session_id: abc-123");
  });
  it("includes project in frontmatter", () => {
    expect(formatConversation(SAMPLE)).toContain(
      "project: /Users/example/project",
    );
  });
  it("includes title in frontmatter", () => {
    expect(formatConversation(SAMPLE)).toContain('title: "Fix auth bug"');
  });
  it("does NOT repeat title as H1", () => {
    expect(formatConversation(SAMPLE)).not.toMatch(/^# Fix auth bug/m);
  });
  it("formats user turns with **User:** prefix", () => {
    expect(formatConversation(SAMPLE)).toContain(
      "**User:** Please fix the bug",
    );
  });
  it("formats assistant turns with **Assistant:** prefix", () => {
    expect(formatConversation(SAMPLE)).toContain("**Assistant:** I'll fix it.");
  });
  it("formats Edit tool call as blockquote diff", () => {
    const md = formatConversation(SAMPLE);
    expect(md).toContain("> **Edit** `src/auth.ts`");
    expect(md).toContain("> - return false;");
    expect(md).toContain("> + return true;");
  });
  it("formats Bash tool call as one-line blockquote", () => {
    expect(formatConversation(SAMPLE)).toContain("> **Bash** `npm test`");
  });
  it("formats Write tool call as one-line blockquote", () => {
    expect(formatConversation(SAMPLE)).toContain("> **Write** `CHANGELOG.md`");
  });
  it("escapes double quotes in title for YAML safety", () => {
    const quoted = formatConversation({
      ...SAMPLE,
      title: 'Fix "critical" bug',
    });
    expect(quoted).toContain('title: "Fix \\"critical\\" bug"');
    expect(quoted).not.toContain('title: "Fix "critical" bug"');
  });
  it("strips newlines from session_id and project in frontmatter", () => {
    const malformed = formatConversation({
      ...SAMPLE,
      sessionId: "abc\n123",
      project: "/Users/test\r\ninjected: evil",
    });
    // Символы переноса строки удалены — YAML-инъекция через новую строку невозможна
    expect(malformed).not.toContain("abc\n123");
    expect(malformed).not.toMatch(/project:.*\n.*injected:/);
    expect(malformed).toContain("session_id: abc 123");
  });
});
