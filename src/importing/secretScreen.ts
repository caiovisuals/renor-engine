import { findSensitive, logSkip, type WriteText } from '../extraction/secretGuard';
import type { ImportPlan, PlannedEvent, PlannedNote } from './plan';

/**
 * RENOR_SECRET_GUARD for the import path (src/extraction/secretGuard.ts has the switch and the scanner).
 *
 * An import is the one way text reaches memory without going through `remember`: it writes note files, index
 * rows and ledger events from a bundle. With the guard on, nothing the scanner flags is written, at two
 * layers that share this screen:
 *
 *   plan    `buildImportPlan` leaves a flagged note or fact out of the plan and says which and why, so the
 *           dry run shows it and every other note is still imported (the way a file whose name is not UTF-8
 *           is already handled);
 *   apply   `applyImportPlan` refuses a plan that still holds one, whole, before its first directory, file,
 *           ledger or index write. A plan built with the guard off, or by another caller, cannot get past it.
 *
 * What is screened is every string the import stores for a note (its destination path, its bytes, its title and
 * kind, its frontmatter, each chunk and its heading, each entity with its type and aliases) and for a carried fact (subject,
 * predicate and object as one line, and its source). The reasons name a path or an event id and a field, never
 * text; a path that itself looks like a secret is withheld.
 */

export interface GuardSkip {
  /** The note's destination path, or the fact's event id. Null when the path itself looks like a secret: never shown. */
  ref: string | null;
  field: string;
  reason: 'credential' | 'identifier';
}

export interface GuardSkips {
  notes: GuardSkip[];
  events: GuardSkip[];
}

/** Every string `applyImportPlan` would store for this note. */
function noteTexts(planned: PlannedNote): WriteText[] {
  const note = planned.note;
  const texts: WriteText[] = [
    { field: 'path', text: planned.relPath },
    { field: 'content', text: planned.content },
    { field: 'title', text: note.title },
    { field: 'kind', text: note.kind ?? '' },
    { field: 'frontmatter', text: JSON.stringify(note.frontmatter ?? {}) },
  ];
  for (const chunk of note.chunks) {
    texts.push({ field: 'chunk', text: chunk.text }, { field: 'chunk heading', text: chunk.headingPath });
  }
  for (const entity of note.entities) {
    texts.push({ field: 'entity', text: entity.canonicalName }, { field: 'entity', text: entity.type });
    for (const alias of entity.aliases ?? []) texts.push({ field: 'entity', text: alias });
  }
  return texts;
}

/** Every string `applyImportPlan` would append to the ledger for this fact. */
function eventTexts(event: PlannedEvent): WriteText[] {
  return [
    { field: 'subject, predicate and object', text: `${event.subject} ${event.predicate}: ${event.object}` },
    { field: 'source', text: event.source },
  ];
}

export function screenNote(planned: PlannedNote): GuardSkip | null {
  const hit = findSensitive(noteTexts(planned));
  if (hit === null) return null;
  // The path was scanned first: if it is what was flagged, it must not be printed.
  return { ref: hit.field === 'path' ? null : planned.relPath, field: hit.field, reason: hit.reason };
}

export function screenEvent(event: PlannedEvent): GuardSkip | null {
  const hit = findSensitive(eventTexts(event));
  return hit === null ? null : { ref: event.id, field: hit.field, reason: hit.reason };
}

/** What a plan still holds that the guard would refuse. Pure: it changes nothing. */
export function screenImportPlan(plan: Pick<ImportPlan, 'notes' | 'events'>): GuardSkips {
  const notes: GuardSkip[] = [];
  for (const planned of plan.notes) {
    const skip = screenNote(planned);
    if (skip) notes.push(skip);
  }
  const events: GuardSkip[] = [];
  for (const event of plan.events) {
    const skip = screenEvent(event);
    if (skip) events.push(skip);
  }
  return { notes, events };
}

const describeSkip = (skip: GuardSkip) => `${skip.ref ?? '(path withheld)'} (${skip.field}: ${skip.reason})`;

/** The apply-time refusal. Counts and names only: the message carries no text from the plan. */
export class ImportRefusedError extends Error {
  readonly skips: GuardSkips;

  constructor(skips: GuardSkips) {
    const all = [...skips.notes, ...skips.events];
    const shown = all.slice(0, 5).map(describeSkip).join('; ');
    super(
      `import refused: ${skips.notes.length} note(s) and ${skips.events.length} fact(s) in this plan appear to contain a credential `
      + 'or personal identifier, and the secret guard (RENOR_SECRET_GUARD) is on, so nothing was written. '
      + 'Build the plan again (it leaves them out) or switch the guard off. '
      + `First: ${shown}${all.length > 5 ? `; and ${all.length - 5} more` : ''}`,
    );
    this.name = 'ImportRefusedError';
    this.skips = skips;
  }
}

/** Throws ImportRefusedError, and writes nothing, when the plan still holds anything the guard would refuse. */
export function refuseFlaggedPlan(plan: Pick<ImportPlan, 'notes' | 'events'>): void {
  const skips = screenImportPlan(plan);
  if (skips.notes.length === 0 && skips.events.length === 0) return;
  for (const skip of [...skips.notes, ...skips.events]) logSkip(skip.field, skip.reason);
  throw new ImportRefusedError(skips);
}

/** The plan-time half: split `notes` and `events` into what stays and what is left out, in order. */
export function leaveOutFlagged(
  notes: PlannedNote[],
  events: PlannedEvent[],
): { notes: PlannedNote[]; events: PlannedEvent[]; skips: GuardSkips } {
  const skips: GuardSkips = { notes: [], events: [] };
  const keptNotes: PlannedNote[] = [];
  for (const planned of notes) {
    const skip = screenNote(planned);
    if (skip) {
      skips.notes.push(skip);
      logSkip(skip.field, skip.reason);
    } else keptNotes.push(planned);
  }
  const keptEvents: PlannedEvent[] = [];
  for (const event of events) {
    const skip = screenEvent(event);
    if (skip) {
      skips.events.push(skip);
      logSkip(skip.field, skip.reason);
    } else keptEvents.push(event);
  }
  return { notes: keptNotes, events: keptEvents, skips };
}
