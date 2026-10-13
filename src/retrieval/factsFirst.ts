import Database from 'better-sqlite3';
import { factsFor } from '../memory/lifecycle';
import { identityNames, ownerNames } from './queryHelpers';
import type { ChunkFilter } from './semantic';

const PREDICATE_CUES: Record<string, string[]> = {
  current_project: [
    'current project',
    'currently building',
    'currently working',
    'working on',
    'building now',
    'what are you building',
    'what am i building',
  ],
  dog_name: ['dog name', "dog's name", 'dog'],
  full_name: ['full name', 'legal name', 'real name'],
  preferred_name: ['preferred name', 'go by', 'called', "what's my name", 'what is my name'],
  location: ['where do i live', 'where does he live', 'lives in', 'live in', 'based in'],
  college_degree: ['college', 'degree', 'university'],
  hackathon_count: ['hackathon'],
  primary_goal: ['primary goal', 'main goal', 'his mission', 'my mission'],
  passport_italian_received: ['passport', 'citizenship'],
  cofounder: ['cofounder', 'co-founder', 'co founder'],
};

/** Owner-named question cues: `{n}` is each configured owner name, so the same phrasings work for any user. */
const OWNER_CUES: Record<string, string[]> = {
  current_project: ['what is {n} building', 'what is {n} currently'],
  location: ['where does {n} live'],
  preferred_name: ["{n}'s name"],
};

/** Letters and digits in any script: the boundary around a name, so `Al` is not found inside `also`. */
const NAME_EDGE_BEFORE = '(?<![\\p{L}\\p{N}])';
const NAME_EDGE_AFTER = '(?![\\p{L}\\p{N}])';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `phrase` as a whole word or phrase in `q`, in any script. */
function hasPhrase(q: string, phrase: string): boolean {
  return new RegExp(`${NAME_EDGE_BEFORE}${escapeRegExp(phrase)}${NAME_EDGE_AFTER}`, 'u').test(q);
}

/** Broad "who is <owner> / who am I" — return a small current-fact card, not every fact. */
const IDENTITY_CARD = new Set([
  'current_project', 'preferred_name', 'full_name', 'location', 'primary_goal', 'dog_name',
]);

function fold(s: string): string {
  return s.trim().toLowerCase();
}

function firstPerson(query: string): boolean {
  return /\b(my|i'm|i am|i've|i'd|i|me)\b/i.test(query);
}

/** Subjects whose lifecycle facts should be considered for this query. */
export function subjectsInQuery(query: string): string[] {
  const q = fold(query);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const key = fold(name);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  const owner = ownerNames();
  if (owner.length) {
    if (owner.some(n => hasPhrase(q, fold(n)))) add(owner[0]);
    if (firstPerson(query)) add(owner[0]);
  }
  return out;
}

function isIdentityCardQuery(query: string): boolean {
  const q = fold(query);
  const owner = ownerNames();
  const named = owner.length ? owner.map(n => escapeRegExp(fold(n))).join('|') : '';
  if (named && new RegExp(`${NAME_EDGE_BEFORE}who is (${named})['’]s${NAME_EDGE_AFTER}`, 'u').test(q)) return false;
  if (hasPhrase(q, 'who am i') || hasPhrase(q, 'tell me about me')) return true;
  return !!named && new RegExp(`${NAME_EDGE_BEFORE}(who is|who['’]s|tell me about|what should i know about) (${named})${NAME_EDGE_AFTER}`, 'u').test(q);
}

function queryMatchesFact(query: string, predicate: string): boolean {
  const q = fold(query);
  if (isIdentityCardQuery(query) && IDENTITY_CARD.has(predicate)) return true;
  const cues = PREDICATE_CUES[predicate] ?? [];
  if (cues.some(c => q.includes(c))) return true;
  const names = ownerNames().map(fold);
  if ((OWNER_CUES[predicate] ?? []).some(t => names.some(n => hasPhrase(q, t.replace('{n}', n))))) return true;
  const pred = fold(predicate).replace(/_/g, ' ');
  if (pred.length >= 3 && q.includes(pred)) return true;
  const words = pred.split(/\s+/).filter(w => w.length >= 4);
  if (words.length >= 2 && words.filter(w => q.includes(w)).length >= 2) return true;
  return false;
}

function factText(subject: string, predicate: string, object: string): string {
  return `${subject}'s ${predicate} is ${object}.`;
}

/**
 * Lifecycle facts that answer a who/what identity question, as retrieval hits.
 * Empty when the query is not about a known subject or no fact matches.
 * Given `keep`, only the hits it shows, judged before the limit.
 */
export function factsFirstHits(db: Database.Database, query: string, limit = 3, keep?: ChunkFilter): Array<{
  notePath: string; chunkId: number; headingPath: string; text: string; score: number; reason: string; author: string | null;
}> {
  const subjects = subjectsInQuery(query);
  if (subjects.length === 0) return [];
  const hits: Array<{
    notePath: string; chunkId: number; headingPath: string; text: string; score: number; reason: string; author: string | null;
  }> = [];
  const seen = new Set<number>();
  for (const subject of subjects) {
    const canonical = identityNames(subject)[0] ?? subject;
    const facts = factsFor(db, subject) as Array<{
      id: number; predicate: string; object_text: string; source_path: string | null; author: string | null;
    }>;
    for (const f of facts) {
      if (seen.has(f.id)) continue;
      if (!queryMatchesFact(query, f.predicate)) continue;
      seen.add(f.id);
      hits.push({
        notePath: f.source_path || '_mcp_',
        // No chunk backs a fact: a negative id is the facts row, which mvp/readScope judges a scoped read by.
        chunkId: -f.id,
        headingPath: `${canonical} > ${f.predicate}`,
        text: factText(canonical, f.predicate, f.object_text ?? ''),
        score: 1.15,
        reason: 'fact',
        // Who saved the fact: the reader's view marks it (agentMemory, search tools), as it marks a fact read by its words.
        author: f.author ?? null,
      });
    }
  }
  return (keep ? hits.filter(keep) : hits).slice(0, limit);
}
