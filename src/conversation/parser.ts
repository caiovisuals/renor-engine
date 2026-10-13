import fs from "fs/promises";
import path from "path";
import os from "os";
import type { ParsedConversation, ConversationTurn, ToolCall } from "./types";

/**
 * Кодирует путь проекта в формат имени директории Claude Code:
 * слэши заменяются на дефисы (как в ~/.claude/projects/).
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Возвращает абсолютный путь к JSONL-файлу сессии в директории проектов Claude Code.
 */
export function resolveJSONLPath(sessionId: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  const projects = path.join(os.homedir(), ".claude", "projects");
  const file = path.join(projects, encoded, `${sessionId}.jsonl`);
  // The session id comes from the hook payload and names a file: a separator or a `..` that leaves the projects
  // directory is refused, never read (a transcript of another file would otherwise be written to the vault).
  if (/[\\/]/.test(sessionId) || !file.startsWith(projects + path.sep)) {
    throw new Error("session_id must name a file in the Claude Code projects directory");
  }
  return file;
}

/**
 * Определяет, является ли сообщение пользователя внутренним (системным).
 * Внутренние сообщения не включаются в итоговый разговор:
 * - только tool_result блоки (ответ инструмента, не пользователь)
 * - сообщения с тегами CLI (local-command, command-name)
 */
function isInternalUserMessage(content: any[]): boolean {
  if (content.length === 0) return true;
  // Только tool_result блоки — ответ инструмента, не настоящий пользователь
  if (content.every((b: any) => b.type === "tool_result")) return true;
  // Внутренние теги Claude Code CLI
  const firstText = content.find((b: any) => b.type === "text")?.text ?? "";
  if (
    firstText.startsWith("<local-command") ||
    firstText.startsWith("<command-name>")
  )
    return true;
  return false;
}

/**
 * Ждёт появления записи ai-title в JSONL-файле с повторными попытками.
 * Claude Code генерирует заголовок асинхронно после завершения сессии,
 * поэтому Stop hook может сработать раньше, чем заголовок записан.
 *
 * @param jsonlPath - путь к .jsonl файлу
 * @param retries - максимальное количество попыток (каждая с задержкой 2с)
 */
async function waitForAiTitle(
  jsonlPath: string,
  retries = 8,
  intervalMs = 2000,
): Promise<string | null> {
  for (let i = 0; i < retries; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    let raw: string;
    try {
      raw = await fs.readFile(jsonlPath, "utf8");
    } catch {
      return null;
    }
    for (const line of raw.split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "ai-title" && entry.aiTitle) {
          return entry.aiTitle as string;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Парсит JSONL-файл сессии Claude Code и возвращает структурированный разговор.
 *
 * @param jsonlPath - путь к .jsonl файлу сессии
 * @param sessionId - идентификатор сессии (используется как fallback заголовок)
 * @param cwd - рабочая директория проекта
 */
export async function parseConversation(
  jsonlPath: string,
  sessionId: string,
  cwd: string,
  options: { maxRetries?: number; retryIntervalMs?: number } = {},
): Promise<ParsedConversation> {
  const raw = await fs.readFile(jsonlPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  let title = sessionId;
  let timeStart = new Date().toISOString();
  let timeStartFound = false;
  const turns: ConversationTurn[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Извлекаем заголовок сессии из специальной записи ai-title
    if (entry.type === "ai-title" && entry.aiTitle) {
      title = entry.aiTitle;
      continue;
    }

    // Время начала = первый dequeue из очереди операций
    if (
      !timeStartFound &&
      entry.type === "queue-operation" &&
      entry.operation === "dequeue"
    ) {
      timeStart = entry.timestamp;
      timeStartFound = true;
      continue;
    }

    // Пропускаем мета-сообщения (системные уведомления Claude Code)
    // и сайдчейн-записи (внутренние подразговоры оркестратора)
    if (entry.isMeta || entry.isSidechain) continue;

    if (entry.type === "user" && entry.message?.role === "user") {
      // content может быть строкой (короткие сессии) или массивом блоков
      const rawContent = entry.message.content;
      const content: any[] = Array.isArray(rawContent)
        ? rawContent
        : typeof rawContent === "string" && rawContent.trim()
          ? [{ type: "text", text: rawContent }]
          : [];
      if (isInternalUserMessage(content)) continue;
      const text = content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text as string)
        .join("\n")
        .trim();
      if (!text) continue;
      turns.push({ role: "user", text, toolCalls: [] });
      continue;
    }

    if (entry.type === "assistant" && entry.message?.role === "assistant") {
      const rawContent = entry.message.content;
      const content: any[] = Array.isArray(rawContent)
        ? rawContent
        : typeof rawContent === "string" && rawContent.trim()
          ? [{ type: "text", text: rawContent }]
          : [];
      const text = content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text as string)
        .join("\n")
        .trim();

      const toolCalls: ToolCall[] = [];
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "Edit" && block.input?.file_path) {
          toolCalls.push({
            kind: "edit",
            filePath: block.input.file_path,
            oldString: block.input.old_string ?? "",
            newString: block.input.new_string ?? "",
          });
        } else if (block.name === "Write" && block.input?.file_path) {
          toolCalls.push({ kind: "write", filePath: block.input.file_path });
        } else if (block.name === "Bash" && block.input?.command) {
          toolCalls.push({ kind: "bash", command: block.input.command });
        }
      }

      if (!text && toolCalls.length === 0) continue;
      turns.push({ role: "assistant", text, toolCalls });
    }
  }

  // Если заголовок не найден — ждём: Claude Code записывает ai-title асинхронно.
  // Ждём только если в JSONL есть queue-operation (признак полноценной сессии).
  // Короткие сессии без queue-operation ai-title не получают.
  const { maxRetries = 8, retryIntervalMs = 2000 } = options;
  if (title === sessionId && timeStartFound && maxRetries > 0) {
    const aiTitle = await waitForAiTitle(jsonlPath, maxRetries, retryIntervalMs);
    if (aiTitle) title = aiTitle;
  }

  return { sessionId, title, timeStart, project: cwd, turns };
}
