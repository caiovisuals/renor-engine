import fs from 'node:fs';
import path from 'node:path';

const ENGINE = path.resolve(__dirname, '../..');

/**
 * Gives an `engine/src` exported from an older commit today's SQLite driver. Trees from before src/db/sqlite.ts import
 * better-sqlite3, which is no longer installed; this copies src/db/sqlite.ts (the same better-sqlite3 API over
 * node:sqlite) into the export and points every better-sqlite3 import at it. A differential that gives both of its
 * sides this same driver still measures only the change it pins.
 */
export function useCurrentDriver(src: string): void {
  fs.copyFileSync(path.join(ENGINE, 'src', 'db', 'sqlite.ts'), path.join(src, 'db', 'sqlite.ts'));
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!text.includes('better-sqlite3')) continue;
      const driver = path.relative(path.dirname(full), path.join(src, 'db', 'sqlite')).replaceAll(path.sep, '/');
      fs.writeFileSync(full, text.replace(/(['"])better-sqlite3\1/g, `'${driver.startsWith('.') ? driver : `./${driver}`}'`));
    }
  };
  visit(src);
}
