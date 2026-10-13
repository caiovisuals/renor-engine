/**
 * The longest statement `remember` admits, in UTF-16 code units (what `String.length` counts, and what
 * a zod `.max()` on a string counts).
 *
 * One number for every place that stores the user's words: the MCP schema, the ledger's `statement`
 * field and the daily-note writer all read it from here, so a statement that is admitted is a statement
 * that is kept. They used to disagree (4000 admitted, 2000 written) and the writer cut the difference
 * without a word.
 */
export const MAX_STATEMENT_LENGTH = 4000;
