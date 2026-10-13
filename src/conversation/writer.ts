import path from "path";
import type { ParsedConversation } from "./types";
import { formatConversation, buildFilename } from "./formatter";
import { assertStorable, secretGuardEnabled } from "../extraction/secretGuard";
import { writeConfined } from "../memory/confinedWrite";

/**
 * Записывает разговор в файл markdown в хранилище.
 * @param vaultPath - корневой путь хранилища
 * @param conversationsDir - относительный путь к папке разговоров (например, "Claude Code/Conversations")
 * @param conv - распарсенный разговор
 * @returns абсолютный путь к созданному файлу
 * @throws Error если обнаружена попытка обхода пути
 */
export async function writeConversation(
  vaultPath: string,
  conversationsDir: string,
  conv: ParsedConversation,
): Promise<string> {
  const filename = buildFilename(conv.title, conv.timeStart);
  const dir = path.join(vaultPath, conversationsDir);

  // Защита от path traversal через имя файла
  const filePath = path.join(dir, filename);
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(dir);
  if (
    !resolvedPath.startsWith(resolvedBase + path.sep) &&
    resolvedPath !== resolvedBase
  ) {
    throw new Error("Path traversal detected in conversation filename");
  }

  // RENOR_SECRET_GUARD (default OFF): a transcript that looks like it holds a secret is not written, and the
  // directory is not created. The caller (the log-conversation hook) reports the refusal and exits cleanly.
  if (secretGuardEnabled()) {
    await assertStorable([
      { field: "conversation", text: formatConversation(conv) },
      { field: "conversation file name", text: filename },
    ]);
  }

  const content = formatConversation(conv);
  // A link, a hard link or a FIFO planted in the vault is refused, never followed (memory/confinedWrite.ts).
  await writeConfined(vaultPath, path.relative(path.resolve(vaultPath), resolvedPath), content);
  return filePath;
}
