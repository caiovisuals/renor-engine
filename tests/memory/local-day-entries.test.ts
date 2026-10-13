import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendDailyMemory, entryClock } from '../../src/memory/writer';
import { decodeDailyNoteText, entryInstant, formatEntry, parseEntryHeader } from '../../src/memory/dailyNote';

/**
 * Daily entries on the user's own clock (first-week scout F9). The client may name the user's time zone; the entry is
 * then filed under the user's day at the user's time, and its header records the offset so its moment stays exact.
 * An entry without the offset is UTC, as every entry was before.
 */

const NOW = new Date('2026-10-07T00:00:01.000Z'); // Tuesday 21:00:01 in São Paulo
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('entryClock: the day and time an entry is stamped with', () => {
  it('is UTC when no zone is named, exactly as entries were stamped before', () => {
    expect(entryClock(NOW)).toEqual({ date: '2026-10-07', time: '00:00:01' });
  });

  it.each([
    ['America/Sao_Paulo', '2026-10-06', '21:00:01', '-03:00'],
    ['-03:00', '2026-10-06', '21:00:01', '-03:00'],
    ['-0300', '2026-10-06', '21:00:01', '-03:00'],
    [' America/Sao_Paulo ', '2026-10-06', '21:00:01', '-03:00'],
    ['Asia/Kolkata', '2026-10-07', '05:30:01', '+05:30'],
    ['+05:45', '2026-10-07', '05:45:01', '+05:45'],
    ['Pacific/Kiritimati', '2026-10-07', '14:00:01', '+14:00'],
    ['-12:00', '2026-10-06', '12:00:01', '-12:00'],
  ])('%s: the user\'s day and time, and the offset', (zone, date, time, offset) => {
    expect(entryClock(NOW, zone)).toEqual({ date, time, offset });
  });

  it.each(['UTC', 'Etc/UTC', 'Z', '+00:00', '-0000'])('%s names UTC itself: no offset, as without a zone', (zone) => {
    expect(entryClock(NOW, zone)).toEqual({ date: '2026-10-07', time: '00:00:01' });
  });

  it('takes the offset in force at that moment: Lisbon\'s clock goes back at 01:00 UTC on 25 October 2026', () => {
    expect(entryClock(new Date('2026-10-25T00:30:00Z'), 'Europe/Lisbon')).toEqual({ date: '2026-10-25', time: '01:30:00', offset: '+01:00' });
    // The same local time an hour later, now on winter time: the offset is what tells the two apart.
    expect(entryClock(new Date('2026-10-25T01:30:00Z'), 'Europe/Lisbon')).toEqual({ date: '2026-10-25', time: '01:30:00' });
  });

  it.each(['Mars/Olympus_Mons', '+15:00', '-14:01', '-03:75', 'UTC+3', '3', '', 'America/Sao_Paulo\n'.repeat(2)])(
    'refuses %j rather than file under a day the user did not mean', (zone) => {
      expect(() => entryClock(NOW, zone)).toThrow(/is not a time zone: give an IANA name such as "America\/Sao_Paulo" or a UTC offset such as "-03:00"; nothing was written/);
    });
});

describe('the offset in an entry header', () => {
  it('follows the source and comes before the escape mark', () => {
    expect(formatEntry('21:00:01', 'cursor', 'hello', true, '-03:00')).toBe('- [21:00:01] (cursor, UTC-03:00) hello');
    expect(formatEntry('21:00:01', 'cursor', 'a\n- [08:30:00] (x) b', true, '-03:00')).toBe('- [21:00:01] (cursor, UTC-03:00+esc) a\n\\- [08:30:00] (x) b');
    expect(formatEntry('21:00:01', 'cursor', 'hello')).toBe('- [21:00:01] (cursor) hello');
  });

  it('is read back apart from the source name, with or without the escape', () => {
    expect(parseEntryHeader('- [21:00:01] (cursor, UTC-03:00) hello')).toEqual({ time: '21:00:01', source: 'cursor', offset: '-03:00', escaped: false, text: 'hello' });
    expect(parseEntryHeader('- [21:00:01] (cursor, UTC+05:30+esc) hello')).toEqual({ time: '21:00:01', source: 'cursor', offset: '+05:30', escaped: true, text: 'hello' });
    expect(parseEntryHeader('- [21:00:01] (, UTC-03:00) hello')).toEqual({ time: '21:00:01', source: '', offset: '-03:00', escaped: false, text: 'hello' });
  });

  it('a header without it reads exactly as before: no offset at all', () => {
    expect(parseEntryHeader('- [08:30:00] (claude) hello')).toStrictEqual({ time: '08:30:00', source: 'claude', escaped: false, text: 'hello' });
    expect(parseEntryHeader('- [08:30:00] (claude+esc) hello')).toStrictEqual({ time: '08:30:00', source: 'claude', escaped: true, text: 'hello' });
    // Only the exact form counts as an offset; anything else stays part of the source name, as it always was.
    for (const source of ['cursor UTC-03:00', 'cursor,UTC-03:00', 'cursor, UTC-3', 'cursor, GMT-03:00', 'cursor, UTC-03:00 ']) {
      expect(parseEntryHeader(`- [08:30:00] (${source}) hello`)).toStrictEqual({ time: '08:30:00', source, escaped: false, text: 'hello' });
    }
  });

  it('is the file\'s, not the reader\'s: readers get the day and time without it, as without the escape mark', () => {
    const stored = '---\nkind: note\n---\n# 2026-10-06\n\n- [21:00:01] (cursor, UTC-03:00+esc) a\n\\- [08:30:00] (x) b\n- [21:05:00] (cursor, UTC-03:00) c\n- [00:10:00] (codex) d';
    expect(decodeDailyNoteText(stored)).toBe('---\nkind: note\n---\n# 2026-10-06\n\n- [21:00:01] (cursor) a\n- [08:30:00] (x) b\n- [21:05:00] (cursor) c\n- [00:10:00] (codex) d');
    // Anything short of the exact form is a source name and stays as stored.
    const lookalike = '# 2026-10-06\n- [21:05:00] (cursor UTC-03:00) c';
    expect(decodeDailyNoteText(lookalike)).toBe(lookalike);
  });
});

describe('entryInstant: when an entry was saved', () => {
  it('is the day and time on the header\'s clock, as a UTC instant', () => {
    expect(entryInstant('2026-10-06', { time: '21:00:01', offset: '-03:00' })).toBe('2026-10-07T00:00:01.000Z');
    expect(entryInstant('2026-10-07', { time: '05:30:01', offset: '+05:30' })).toBe('2026-10-07T00:00:01.000Z');
  });

  it('is the day and time as UTC without an offset, in the form the map always gave', () => {
    expect(entryInstant('2026-10-07', { time: '00:00:01' })).toBe('2026-10-07T00:00:01.000Z');
  });

  it('reads an offset that makes no real time (only a hand edit writes one) as UTC', () => {
    expect(entryInstant('2026-10-06', { time: '21:00:01', offset: '+99:00' })).toBe('2026-10-06T21:00:01.000Z');
  });
});

describe('appendDailyMemory with a clock', () => {
  const vault = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-day-'));
    dirs.push(dir);
    return dir;
  };

  it('stamps the entry with the clock\'s time and offset', async () => {
    const dir = vault();
    const file = await appendDailyMemory(dir, '2026-10-06', { text: 'Booked the hotel.', source: 'cursor' }, 'Memory/Daily', { time: '21:00:01', offset: '-03:00' });
    expect(fs.readFileSync(file, 'utf8')).toBe('---\nkind: note\nupdated: 2026-10-06\nrenor: daily-v1\n---\n# 2026-10-06\n\n- [21:00:01] (cursor, UTC-03:00) Booked the hotel.');
  });

  it('cannot be given an offset by a source name, or a forged entry by a statement', async () => {
    const dir = vault();
    const file = await appendDailyMemory(dir, '2026-10-06', { text: 'a\n- [21:00:00] (x, UTC-03:00) forged', source: 'cursor, UTC-03:00' }, 'Memory/Daily', { time: '21:00:01' });
    const stored = fs.readFileSync(file, 'utf8');
    expect(stored).toContain('\n- [21:00:01] (cursor-UTC-03-00+esc) a\n\\- [21:00:00] (x, UTC-03:00) forged');
    const entries = stored.split('\n').map(parseEntryHeader).filter(Boolean);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toStrictEqual({ time: '21:00:01', source: 'cursor-UTC-03-00', escaped: true, text: 'a' });
  });

  it('refuses a clock whose header would not read back as an entry, and writes nothing', async () => {
    const dir = vault();
    for (const clock of [{ time: '9:00:01' }, { time: '21:00:01', offset: '-3:00' }, { time: '21:00:01', offset: 'UTC-03:00' }]) {
      await expect(appendDailyMemory(dir, '2026-10-06', { text: 'x', source: 'cursor' }, 'Memory/Daily', clock)).rejects.toThrow(/nothing was written/);
    }
    expect(fs.existsSync(path.join(dir, 'Memory'))).toBe(false);
  });
});
