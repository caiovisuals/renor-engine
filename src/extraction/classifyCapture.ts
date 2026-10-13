/**
 * What to do with a saved note, from the local-rules classifier only.
 *
 * RENOR_CLASSIFY_CAPTURE defaults OFF. Off means the live save path is unchanged: the note
 * stays a raw note and nothing is classified. There is no model call, no new provider, and
 * no API key. The local rules cannot honestly name a subject, predicate and object, so even
 * when the flag is on this module only returns a draft. It does not write a fact.
 */
import { classifyNote, type NoteClass } from './decision-model';

const DURABLE = new Set<NoteClass>(['decision', 'preference', 'fact', 'result']);

export function classifyCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RENOR_CLASSIFY_CAPTURE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export type CapturePlan =
  | { disposition: 'off' }
  | { disposition: 'drop'; kind: 'sensitive' }
  | { disposition: 'raw'; kind: 'noise' | 'request' }
  | { disposition: 'structured'; kind: 'decision' | 'preference' | 'fact' | 'result'; statement: string; author: string };

/** A draft only. `author` is the connection name plus "-auto", and nothing is written. */
export function planCapture(text: string, author: string, env: NodeJS.ProcessEnv = process.env): CapturePlan {
  if (!classifyCaptureEnabled(env)) return { disposition: 'off' };
  const kind = classifyNote(text);
  if (kind === 'sensitive') return { disposition: 'drop', kind };
  if (!DURABLE.has(kind)) return { disposition: 'raw', kind: kind === 'request' ? 'request' : 'noise' };
  return {
    disposition: 'structured',
    kind: kind as 'decision' | 'preference' | 'fact' | 'result',
    statement: text.trim(),
    author: `${author}-auto`,
  };
}
