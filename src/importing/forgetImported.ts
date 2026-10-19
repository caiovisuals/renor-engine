import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { journalLogName } from './journalLog';

/**
 * The import journal: one JSON manifest per batch in `.renor-imports/` (hosted.ts writes it and undo_import reads it). While a
 * batch is applying, its notes are in a sidecar log beside the manifest instead (journalLog.ts).
 * It names every note a batch created, by path, and the batch's label, which is the folder name of those notes. A note that is
 * permanently deleted (purgeRetired) leaves no trace there: its path is a name the owner chose, and the label can say more
 * than the note does.
 */
export const IMPORT_JOURNAL_DIR = '.renor-imports';

interface ManifestFile {
  batchId?: unknown;
  state?: unknown;
  created?: Array<{ relPath?: unknown }>;
  result?: { conflicts?: unknown; [key: string]: unknown };
}

async function replaceManifest(file: string, manifest: object): Promise<void> {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  await fs.rename(tmp, file);
  // A batch that is no longer applying has no log of its own to keep: a log left beside it would still name the paths removed here.
  await fs.rm(path.join(path.dirname(file), journalLogName(path.basename(file, '.json'))), { force: true }).catch(() => undefined);
}

/**
 * Remove the given note paths from every import manifest: from `created` (so undo_import has nothing to retire for them) and
 * from `result.conflicts`. A batch left with no note is kept as a record that it is over, with its id and state `undone`, but
 * without its label, paths or counts, so undo_import and a second apply say so instead of "not found". A batch that still
 * holds other notes keeps them, and its label, which is their folder. An apply still running is left alone: it writes its own
 * journal. Each file is replaced atomically. Idempotent, so a retry after a crash repeats it harmlessly. A file that is not a
 * plain manifest is left alone.
 */
export async function forgetImportedNotes(memoryDir: string, relPaths: ReadonlySet<string>): Promise<void> {
  if (relPaths.size === 0) return;
  const dir = path.join(memoryDir, IMPORT_JOURNAL_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const st = await fs.lstat(file);
    if (!st.isFile()) continue;
    let manifest: ManifestFile;
    try {
      manifest = JSON.parse(await fs.readFile(file, 'utf8')) as ManifestFile;
    } catch {
      continue;
    }
    if (!Array.isArray(manifest.created) || manifest.state === 'applying') continue;
    const created = manifest.created.filter((c) => !relPaths.has(String(c.relPath)));
    const conflictsWas = Array.isArray(manifest.result?.conflicts) ? (manifest.result!.conflicts as unknown[]) : null;
    const conflicts = conflictsWas?.filter((p) => !relPaths.has(String(p))) ?? null;
    const changed = created.length !== manifest.created.length || (conflicts !== null && conflicts.length !== conflictsWas!.length);
    if (!changed) continue;
    if (created.length === 0) {
      await replaceManifest(file, { batchId: String(manifest.batchId ?? path.basename(name, '.json')), state: 'undone', created: [] });
      continue;
    }
    manifest.created = created;
    if (conflicts !== null) manifest.result = { ...manifest.result, conflicts };
    await replaceManifest(file, manifest);
  }
}
