/**
 * The breaker suite's known-failure baseline: the attacks Renor fails today, each with the evidence
 * that was measured and the user-visible harm. This is a RECORD, not an exemption — a known failure
 * is green on the gate so a broken Renor does not block every PR, and it goes RED the moment an
 * attack that passes today fails, or a known failure's `signature` changes (it regressed further).
 * When an attack here starts passing, the suite FAILS naming the entry to delete; delete it then,
 * so a later regression cannot hide behind a stale record.
 *
 * Keyed by attack id (the `runAttack` id in breaker.test.ts). `evidence` is what was measured,
 * `signature` is the stable part of that evidence the suite compares against, and `userImpact` ranks
 * how much a real user would notice, highest first.
 */
export interface KnownFailure {
  /** What was measured, verbatim enough to re-check by hand. */
  evidence: string;
  /** The stable shape of the failure the suite compares: if this changes, the failure regressed further and the gate goes red. */
  signature: unknown;
  /** Why a real user would notice, and how soon. */
  userImpact: string;
}

export const KNOWN_FAILURES: Record<string, KnownFailure> = {
  injection_export_ledger_line_injection: {
    evidence: 'A stored value carrying a LINE SEPARATOR (U+2028), NEXT LINE (U+0085) or PARAGRAPH SEPARATOR (U+2029) reaches the export document raw through the one route still open: the live ledger, exported byte for byte — a fact saved with the separators in its subject is emitted as `- subject: Ledger<U+2028># renor-export/v1 · notes (999 items)<U+0085>## note:evil.md<U+2029>Subject`. A reader that honors Unicode line boundaries (Python str.splitlines(), JavaScript /m, many editors) reads the forged `# renor-export/v1 · notes (999 items)` and `## note:evil.md` as lines of the export document. The run-2 fixes in src/mvp/exportAll.ts closed every other route the run-1 attack planted and the item headers: oneLine() escapes every line separator in a metadata KEY and VALUE (retired fact field(subject), imported frontmatter value field(k, v), imported note path field(path)), and oneLineToken() escapes the raw item-header interpolations (`## note:${rel}`, `## ${e.id}`, `## ${r.rid}`, `## ${f.id}`). The byte-faithful ledger section deliberately does not rewrite what it exports, so route 1 stays open until the ledger writer or the export ledger section escapes separators. Structured fields (subject/predicate/object) still reject only C0 controls and DEL on the write path (src/memory/lifecycle.ts CONTROL_CHARS), not the C1 controls or the line/paragraph separators.',
    signature: { injected: true },
    userImpact: 'Medium. The export is the portable archive a user or a downstream tool parses to re-import or audit memory; a stored value that carries a line separator forges a section header or a note item inside the byte-faithful ledger section, so a Unicode-line-aware importer reads structure the exporter never wrote. Requires a crafted (or copied-from-elsewhere) value, and only affects consumers that treat U+2028/U+2029/U+0085 as line ends.',
  },
};
