import type { ClusterKind, DreamerFact } from './candidates';

/**
 * The collection guard. Some predicates hold a collection: what a project supports, who contributes
 * to it, which languages someone speaks. A newer value for such a predicate is another member, not a replacement, and a
 * model reading two facts cannot always tell (it replaced one member in 6 of 8 clusters with the round-2 "newest value wins"
 * prompt, 2 of 8 once the prompt named collections). So the dreamer does not rely on the prompt alone: a group about a
 * collection predicate is never superseded automatically. It is reported as `both-may-hold` and left as it is.
 *
 * Two deterministic signs, no model:
 *   1. the predicate's name: a word that names a collection or a verb that makes one ("supports", "integrates_with",
 *      "exports", "contributors", "languages", "skills"...), or a plural noun;
 *   2. the workspace: three or more different current values for one predicate under the same thing, when the reader
 *      did not call each value replaced by the next one. A single-valued attribute does not keep three values for long (the lifecycle
 *      replaces a value saved under the same name and scope), but a plain chain of replacements under three spellings of
 *      a name (Fly.io -> ECS -> Render) has three too, and is exactly what the dreamer is for: so a group whose consecutive pairs
 *      are all "updates" is a chain and is not held back.
 *
 * The guard errs toward holding back: a false "collection" costs a stale value left in place (what the dreamer did not do
 * yesterday either), a missed one costs a member hidden from current reads (history keeps it). It does not know a
 * collection by an unusual name; the prompt and the second look are the backstop there, and the report says so.
 */

/** Words that make a predicate a collection or a membership, split on `_`, `-` and spaces. Exact words only. */
const COLLECTION_WORDS = new Set([
  'supports', 'supported', 'supporting', 'integrates', 'integration', 'integrations', 'exports', 'export', 'exported',
  'imports', 'offers', 'includes', 'contains', 'speaks', 'knows', 'holds', 'plays', 'reads',
  'member', 'members', 'contributor', 'contributors', 'maintainers', 'collaborators', 'participants', 'attendees', 'reviewers',
  'skill', 'skills', 'certification', 'certifications', 'hobby', 'hobbies', 'interest', 'interests', 'language', 'languages',
  'plugin', 'plugins', 'extension', 'extensions', 'tag', 'tags', 'topic', 'topics', 'label', 'labels', 'dependency', 'dependencies',
  'endpoint', 'endpoints', 'feature', 'features', 'capability', 'capabilities', 'compatible', 'compatibility',
  'alias', 'aliases', 'allowlist', 'blocklist', 'whitelist', 'blacklist', 'also',
]);

/** Phrases (consecutive words) that make a collection and are not single words above. */
const COLLECTION_PHRASES: ReadonlyArray<readonly string[]> = [
  ['works', 'with'], ['member', 'of'], ['contributes', 'to'], ['belongs', 'to'], ['part', 'of'], ['related', 'to'],
];

/** Plural-looking words that are not plurals ("status", "address", "dns"...), so the plural rule leaves them alone. */
const NOT_PLURAL = new Set([
  'status', 'address', 'class', 'process', 'access', 'analysis', 'alias', 'bias', 'canvas', 'business', 'progress', 'focus', 'bonus',
  'plus', 'series', 'species', 'news', 'mass', 'glass', 'loss', 'gas', 'lens', 'sms', 'aws', 'https', 'dns', 'tls', 'ios', 'cors',
  'js', 'css', 'pass', 'less', 'success', 'chaos', 'basis', 'axis', 'radius', 'virus', 'campus', 'corpus', 'consensus', 'previous',
  'various', 'serious', 'famous', 'always', 'perhaps', 'across', 'versus', 'its', 'this', 'has', 'was', 'does', 'goes', 'is', 'as',
  'uses', 'raises', 'increases',
  // plural in form, one value in practice: a span of time, a limit, a setting ("working_hours" is one range, "rate_limits" one number)
  'hours', 'days', 'minutes', 'seconds', 'weeks', 'months', 'years', 'times', 'dates', 'limits', 'settings', 'options',
]);

const wordsOf = (predicate: string): string[] => predicate.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function pluralWord(word: string): boolean {
  if (word.length < 5 || NOT_PLURAL.has(word)) return false;
  if (!word.endsWith('s')) return false;
  if (/(ss|us|is|os)$/.test(word)) return false;
  return true;
}

/** Whether the NAME of a predicate says it holds a collection, and which rule said so. */
export function collectionByName(predicate: string): { collection: boolean; why: string } {
  const words = wordsOf(predicate);
  const listed = words.find(w => COLLECTION_WORDS.has(w));
  if (listed) return { collection: true, why: `collection word "${listed}"` };
  for (const phrase of COLLECTION_PHRASES) {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((w, j) => words[i + j] === w)) return { collection: true, why: `collection phrase "${phrase.join('_')}"` };
    }
  }
  const plural = words.find(pluralWord);
  if (plural) return { collection: true, why: 'plural word' };
  return { collection: false, why: '' };
}

/** Whether each fact (oldest first) was called replaced by the next one: a chain of replacements, whatever the other pairs say. */
function isChain(facts: DreamerFact[], pairs: ReadonlyArray<{ older: number; newer: number; verdict: string }>): boolean {
  for (let i = 0; i + 1 < facts.length; i++) {
    const pair = pairs.find(p => p.older === facts[i].id && p.newer === facts[i + 1].id);
    if (pair?.verdict !== 'updates') return false;
  }
  return true;
}

/** The number of current values for one predicate under the same thing at which the workspace itself says it is a collection. */
export const SEVERAL_CURRENT_VALUES = 3;

/**
 * Whether a candidate group is about a collection: by the name of its predicate, or because it holds three or more different
 * current values for it and (when the labels are known) the reader did not call every pair an update. Without labels (a look at a workspace before any
 * model is asked) the second sign is not applied: it needs the reader. A `predicate` group (two predicates, one naming
 * the other's value) is never written anyway.
 */
export function collectionVerdict(kind: ClusterKind, facts: DreamerFact[], pairs?: ReadonlyArray<{ older: number; newer: number; verdict: string }>): { collection: boolean; why: string } {
  if (kind === 'predicate') return { collection: false, why: '' };
  const byName = collectionByName(facts[0].predicate);
  if (byName.collection) return byName;
  const values = new Set(facts.map(f => f.object.trim().toLowerCase()));
  if (pairs && facts.length >= SEVERAL_CURRENT_VALUES && values.size >= SEVERAL_CURRENT_VALUES && !isChain(facts, pairs)) return { collection: true, why: `${values.size} current values` };
  return { collection: false, why: '' };
}
