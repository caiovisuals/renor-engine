import crypto from "crypto";
import type { ParsedConversation, ConversationTurn, ToolCall } from "./types";

// Возвращает YYYY-MM-DD из ISO-строки
function isoToDate(iso: string): string {
  return iso.substring(0, 10);
}

// Возвращает HH:mm из ISO-строки
function isoToTime(iso: string): string {
  return iso.substring(11, 16);
}

// A file name is at most 255 bytes; the date prefix and ".md" take about 22 of them, so the title gets this many UTF-8 bytes.
const MAX_TITLE_BYTES = 120;

// Убирает символы, недопустимые в именах файлов, и управляющие символы (NUL ломает путь); длинное название обрезается
// и получает короткий хеш полного названия, чтобы разные разговоры не совпали по имени файла.
function sanitizeTitle(title: string): string {
  const clean = title.replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, "-").trim();
  if (Buffer.byteLength(clean, "utf8") <= MAX_TITLE_BYTES) return clean;
  let kept = "";
  for (const ch of clean) {
    if (Buffer.byteLength(kept + ch, "utf8") > MAX_TITLE_BYTES) break;
    kept += ch;
  }
  const digest = crypto.createHash("sha256").update(title).digest("hex").slice(0, 8);
  return `${kept.trimEnd()}-${digest}`;
}

export function buildFilename(title: string, isoTime: string): string {
  const date = isoToDate(isoTime);
  const time = isoToTime(isoTime).replace(":", "-");
  return `${date} ${time} - ${sanitizeTitle(title)}.md`;
}

function formatToolCall(tc: ToolCall): string {
  if (tc.kind === "edit") {
    const diffLines = [
      ...tc.oldString.split("\n").map((l) => `> - ${l}`),
      ...tc.newString.split("\n").map((l) => `> + ${l}`),
    ].join("\n");
    return `> **Edit** \`${tc.filePath}\`\n> \`\`\`diff\n${diffLines}\n> \`\`\``;
  }
  if (tc.kind === "write") {
    return `> **Write** \`${tc.filePath}\``;
  }
  return `> **Bash** \`${tc.command}\``;
}

function formatTurn(turn: ConversationTurn): string {
  const parts: string[] = [];
  if (turn.text) {
    const label = turn.role === "user" ? "User" : "Assistant";
    parts.push(`**${label}:** ${turn.text}`);
  }
  for (const tc of turn.toolCalls) {
    parts.push(formatToolCall(tc));
  }
  return parts.join("\n\n");
}

export function formatConversation(conv: ParsedConversation): string {
  const date = isoToDate(conv.timeStart);
  const timeStart = isoToTime(conv.timeStart);
  // Убираем переносы строк, чтобы не сломать YAML-фронтматтер
  const safeSessionId = conv.sessionId.replace(/[\r\n]/g, " ");
  const safeProject = conv.project.replace(/[\r\n]/g, " ");

  const frontmatter = [
    "---",
    "kind: conversation",
    `date: ${date}`,
    `time_start: ${timeStart}`,
    `session_id: ${safeSessionId}`,
    `project: ${safeProject}`,
    `title: ${JSON.stringify(conv.title)}`,
    "---",
  ].join("\n");

  const body = conv.turns.map(formatTurn).filter(Boolean).join("\n\n");

  return `${frontmatter}\n\n${body}\n`;
}
