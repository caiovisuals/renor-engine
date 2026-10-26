import { CLI_WORDING_VERSION, fieldsAtLevel, type SharingLevel } from './fields';

/**
 * The words the command line shows before it records a choice. The version id (CLI_WORDING_VERSION) is stored with the
 * choice, so the record shows which words the user saw. Change the words, change the id.
 *
 * These are the command line's own words. They are not the privacy policy: the public wording (policy, terms, website) is the
 * owner's and a lawyer's to approve and is not part of this file. docs/TELEMETRY.md has the same facts for reading offline.
 */

export function wordingFor(level: Exclude<SharingLevel, 'off'>): string {
  const common = [
    'Renor can learn from how its memory is used, if you choose to help. Off is the default and stays off unless you pick a level here.',
    '',
    'Nothing is sent until you choose. You can change this at any time with `renor-engine telemetry off`, and `renor-engine telemetry delete`',
    'removes what Renor holds. Turning it off stops recording at once and asks Renor to delete what it holds, at once (backups can keep a',
    'copy for up to 7 more days). A ranking setting already fitted from rows is not recalled; the next fit leaves yours out.',
    'Sharing never changes your plan, quota or features. Renor keeps signal rows up to 12 months and text examples up to 6 months.',
    '',
  ];
  if (level === 'signals') {
    return [
      ...common,
      'LEVEL: share signals',
      '  Sent: anonymous labelled numbers, worked out inside your own data folder from the learning log: which kind of memory was returned,',
      '  in what position, with what score, and whether your AI then opened, cited, updated or retired it, with times rounded to the hour.',
      '  Never sent: memory text, queries, titles, names, file paths, memory ids, keys or your IP address stored with the rows.',
      '  Every field is listed by `renor-engine telemetry fields signals`, and `renor-engine telemetry preview` prints exactly what would be sent.',
    ].join('\n');
  }
  return [
    ...common,
    'LEVEL: share data for training',
    '  Sent: everything in "share signals", plus the TEXT of the examples: the query behind a retrieval, the text of the memories it returned,',
    '  and the statements that were saved. Renor may use that text to train and evaluate its own models.',
    '  Memories can contain other people\'s personal data and information about you. A text that looks like a secret (key, password, token)',
    '  is left out, but no scanner is perfect: choose this only if you accept that.',
    '  Every field is listed by `renor-engine telemetry fields data`, and `renor-engine telemetry preview` prints exactly what would be sent.',
  ].join('\n');
}

export const ADULT_LINE = 'I am 18 or older and I choose this myself.';

export function fieldList(level: Exclude<SharingLevel, 'off'>): string {
  return fieldsAtLevel(level).join('\n');
}

export { CLI_WORDING_VERSION };
