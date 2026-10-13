import fs from 'fs';
import path from 'path';

/**
 * How many bytes of Markdown a workspace stores: its notes and the engine's own ledger, every regular `.md` file under
 * the memory directory. The search index (`.memory-index/`), the caches and the auth state are derived or private
 * state, not the user's memory, and are not counted. A symbolic link is never followed.
 *
 * The figure goes to the gateway on the `/internal/gateway-token` call it makes for every request, so the control plane
 * can record it, show it, and cap writes, without a call of its own and without waking an engine to ask: an engine that
 * is asleep has not changed what it stores.
 */

/** The folder holding the index. It sits inside the memory directory and is never user content. */
const INDEX_DIR = '.memory-index';
/** Files stat'ed at once: enough to hide the latency, few enough to stay polite to a small VM. */
const STAT_CHUNK = 64;

/** The bytes of every regular `.md` file below `root`. Unreadable content fails measurement; vanished files are skipped. */
export async function measureMarkdownBytes(root: string): Promise<number> {
  let total = 0;
  const folders = [root];
  while (folders.length > 0) {
    const folder = folders.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch (err) {
      // A folder that vanished while the walk was running is not an error; an unreadable root is.
      if (folder === root || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      continue;
    }
    const files: string[] = [];
    for (const entry of entries) {
      // `isDirectory()` and `isFile()` are false for a symbolic link, so a link is skipped, never followed.
      if (entry.isDirectory()) {
        if (entry.name !== INDEX_DIR) folders.push(path.join(folder, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.join(folder, entry.name));
      }
    }
    for (let i = 0; i < files.length; i += STAT_CHUNK) {
      const sizes = await Promise.all(
        files.slice(i, i + STAT_CHUNK).map(async (file) => {
          try {
            const stat = await fs.promises.lstat(file);
            return stat.isFile() ? stat.size : 0;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            return 0; // deleted between the listing and the stat
          }
        }),
      );
      for (const size of sizes) total += size;
    }
  }
  return total;
}

export interface StoredSizeOptions {
  /** How long a figure is served before one more measurement is started. */
  ttlMs?: number;
  now?: () => number;
  /** For tests: what measures. */
  measure?: (dir: string) => Promise<number>;
}

/**
 * The last measured size, served at once by read(). It never blocks and never throws: a missing or stale figure only starts one
 * measurement in the background (one at a time), whose result the next caller gets. The first measurement starts when
 * the gauge is made, so early reporting calls can have a figure. A measurement that fails keeps the last good
 * figure and is retried after the TTL, not on every reporting call. readFresh() instead awaits a current walk for admission.
 */
export class StoredSizeGauge {
  private bytes: number | null = null;
  private measuredAt = 0;
  private running: Promise<void> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly measure: (dir: string) => Promise<number>;

  constructor(private readonly dir: string, options: StoredSizeOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.measure = options.measure ?? measureMarkdownBytes;
    this.refresh();
  }

  /** The bytes as of the last finished measurement, or null before the first one has finished. */
  read(): number | null {
    if (this.bytes === null || this.now() - this.measuredAt >= this.ttlMs) this.refresh();
    return this.bytes;
  }

  private refresh(): void {
    if (this.running) return;
    // Started now, and whatever a measurement does, even a synchronous throw, stays out of the caller's way.
    let attempt: Promise<number>;
    try {
      attempt = Promise.resolve(this.measure(this.dir));
    } catch (err) {
      attempt = Promise.reject(err);
    }
    this.running = attempt
      .then(
        (bytes) => {
          if (Number.isSafeInteger(bytes) && bytes >= 0) this.bytes = bytes;
        },
        () => {
          // Keep the last good figure.
        },
      )
      .finally(() => {
        this.measuredAt = this.now();
        this.running = null;
      });
  }

  /** Admission checks must measure after previous writes, never reuse the TTL or an in-flight older walk. */
  async readFresh(): Promise<number | null> {
    await this.settled();
    try {
      const bytes = await this.measure(this.dir);
      if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
      this.bytes = bytes;
      this.measuredAt = this.now();
      return bytes;
    } catch {
      // A cached good value cannot authorize a write after a failed current measurement.
      return null;
    }
  }

  /** Resolves when the measurement in flight, if any, has finished. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }
}
