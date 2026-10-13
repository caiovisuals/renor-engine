/**
 * True when `text` holds nothing a reader can see: only whitespace, the Unicode default-ignorable code
 * points, the Unicode format controls, and the two blank symbols — U+2800 BRAILLE PATTERN BLANK and
 * U+FFFC OBJECT REPLACEMENT CHARACTER — which render as nothing but are neither whitespace nor
 * default-ignorable.
 *
 * A subject, predicate, object, note or statement made only of these is refused on write, so a memory
 * that looks empty is never stored and no user has to correct one they cannot see. One rule for every
 * write path: the ledger's structured fields (`refuseUnstorableFields`), the daily-note writer
 * (`checkedNoteText`) and the import preview all read it here, so a blank a reader cannot see is blank
 * everywhere. Whitespace and default-ignorable alone left U+2800, U+FFFC and the interlinear-annotation
 * controls U+FFF9..U+FFFB accepted (breaker run 2).
 */
const BLANK_OR_INVISIBLE = /^[\s\p{Default_Ignorable_Code_Point}\p{Cf}\u2800\uFFFC]*$/u;

export function isBlankOrInvisible(text: string): boolean {
  return BLANK_OR_INVISIBLE.test(text);
}
