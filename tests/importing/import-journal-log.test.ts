import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JournalLog, journalLogName, readJournalLog, removeJournalLog, type JournalLogEntry } from '../../src/importing/journalLog';

/**
 * The import journal's sidecar (src/importing/journalLog.ts): one line per note a batch applying appends, and fsyncs. A crash
 * cuts at most the last line, and a cut line names no note: it is the note being written, which is outside the journal, as
 * it was before the sidecar. A complete line that does not parse is damage, and the reader refuses it.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-journal-log-'));
  dirs.push(dir);
  return dir;
}

const digest = (n: number) => String(n).repeat(64).slice(0, 64);
const created = (n: number): JournalLogEntry => ({ list: 'created', relPath: `Imported/fixture/notes/note-${n}.md`, hash: digest(n) });

describe('the import journal sidecar', () => {
  it('reads back the lines a batch appended, in the order they were appended', () => {
    const file = path.join(tmpDir(), journalLogName('6f1d0c2e-9a4b-4c3d-8e2f-1a0b9c8d7e6f'));
    const log = new JournalLog(file);
    log.append(created(1));
    log.append({ list: 'reasserted', relPath: 'Imported/fixture/notes/note-2.md', hash: digest(2) });
    log.append(created(3));
    log.close();
    log.close(); // idempotent
    expect(readJournalLog(file)).toEqual([created(1), { list: 'reasserted', relPath: 'Imported/fixture/notes/note-2.md', hash: digest(2) }, created(3)]);
    expect(fs.readFileSync(file, 'utf8').split('\n').slice(0, 3).map(line => JSON.parse(line).relPath)).toEqual(
      ['Imported/fixture/notes/note-1.md', 'Imported/fixture/notes/note-2.md', 'Imported/fixture/notes/note-3.md'],
    );
  });

  it('is absent for a batch with no log, and a log that is never appended to is never created', () => {
    const dir = tmpDir();
    expect(readJournalLog(path.join(dir, journalLogName('none')))).toBeUndefined();
    const unused = path.join(dir, journalLogName('unused'));
    new JournalLog(unused).close();
    expect(fs.existsSync(unused)).toBe(false);
  });

  it('keeps every whole line wherever a crash cut the last one, and never reads the cut line as a note', () => {
    const dir = tmpDir();
    const file = path.join(dir, journalLogName('cut'));
    const whole = `${JSON.stringify(created(1))}\n${JSON.stringify(created(2))}\n`;
    const third = `${JSON.stringify(created(3))}\n`;
    const failures: string[] = [];
    // Every byte the third line could have been cut at, the full line included.
    for (let cut = 0; cut <= third.length; cut++) {
      fs.writeFileSync(file, whole + third.slice(0, cut));
      const read = readJournalLog(file) ?? [];
      const expected = cut === third.length ? 3 : 2;
      if (read.length !== expected) failures.push(`cut at ${cut}: read ${read.length}, expected ${expected}`);
    }
    expect(failures).toEqual([]);
  });

  it('refuses a complete line that does not parse, rather than dropping a note it cannot name', () => {
    const file = path.join(tmpDir(), journalLogName('damaged'));
    fs.writeFileSync(file, `${JSON.stringify(created(1))}\nnot a journal line\n${JSON.stringify(created(2))}\n`);
    expect(() => readJournalLog(file)).toThrow(/cannot be read; undo_import stopped before changing anything/);
  });

  it('refuses a line of the wrong shape as damage too', () => {
    const file = path.join(tmpDir(), journalLogName('wrong-shape'));
    fs.writeFileSync(file, `${JSON.stringify({ list: 'retired', relPath: 'x.md', hash: digest(1) })}\n`);
    expect(() => readJournalLog(file)).toThrow(/cannot be read/);
  });

  it('never follows a symbolic link, neither to read a log nor to create one', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'elsewhere.jsonl');
    fs.writeFileSync(target, `${JSON.stringify(created(1))}\n`);
    const link = path.join(dir, journalLogName('linked'));
    fs.symlinkSync(target, link);
    expect(() => readJournalLog(link)).toThrow(/Unsafe import journal/);
    expect(() => new JournalLog(link).append(created(2))).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe(`${JSON.stringify(created(1))}\n`);
  });

  it('is removed once, and removing an absent log is not an error', () => {
    const file = path.join(tmpDir(), journalLogName('gone'));
    const log = new JournalLog(file);
    log.append(created(1));
    log.close();
    removeJournalLog(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removeJournalLog(file)).not.toThrow();
  });
});
