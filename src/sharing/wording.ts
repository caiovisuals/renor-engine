import { CLI_WORDING_VERSION, DEFAULT_WORDING_VERSION, fieldsAtLevel, type SharingLevel } from './fields';

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
    'Sharing never changes your plan, quota or features. What you share is kept as long as it helps improve Renor, with no fixed period, and is deleted when you ask or turn it off.',
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

/**
 * The words about the default, shown by `renor-engine telemetry status` and once by the service at start-up while the default is in
 * force. The command line's own words, not the privacy policy (see the header); the owner's approved wording replaces them
 * before the default is turned on, and the id changes with it (DEFAULT_WORDING_VERSION).
 */
export function defaultWording(): string {
  return [
    'Renor shares usage numbers by default, so that it can get better at remembering for everyone. You have not chosen, so this applies.',
    '  Sent: numbers only, worked out inside your own data folder: which kind of memory was returned, in what position, with what score, and whether your AI then opened,',
    '  cited, updated or retired it, with times rounded to the hour. Never memory text, queries, titles, names, file paths, memory ids or keys.',
    '  Every field is listed by `renor-engine telemetry fields signals`, and `renor-engine telemetry preview` prints exactly what would be sent.',
    '  They are stored under a random install identifier that stays the same until you turn sharing off.',
    '  Turn it off at any time with `renor-engine telemetry off` (or DO_NOT_TRACK=1): this install stops recording and sending, and Renor is asked to delete what it holds for it.',
    '  Sharing text for training is a separate choice and is never on by default.',
    `  (words: ${DEFAULT_WORDING_VERSION})`,
  ].join('\n');
}

export const ADULT_LINE = 'I am 18 or older and I choose this myself.';

export function fieldList(level: Exclude<SharingLevel, 'off'>): string {
  return fieldsAtLevel(level).join('\n');
}

export { CLI_WORDING_VERSION };
