import type Database from 'better-sqlite3';

/**
 * The zero-yield half of the ADR-0003 §4.2 lane cache (#189).
 *
 * The row-based half lives in `structured_rows`: a CURRENT row for
 * (source_path, row_kind, source_hash, extraction_version) means "this lane is
 * done for these bytes". A lane that RUNS and produces nothing leaves no row,
 * so that half cannot record it, and every later pass over the same unchanged
 * note calls the extractor again — repeated model calls and rate-limit exposure
 * for a note that yielded nothing, forever.
 *
 * `lane_runs` (migration v12) records the last COMPLETED run of one lane on one
 * note, so the zero-yield case has a checkpoint of its own. It is deliberately
 * NOT a row in `structured_rows`: that table is the scored side of the eval
 * boundary, and a marker row there would be served as an extracted fact.
 *
 * Contract, and why each half of it exists:
 *   - written ONLY after the extractor AND the adjudicated writes both returned
 *     successfully. The throw path resets `notes.note_hash` so the next pass
 *     retries; a failure must never be cached as a completed run.
 *   - keyed by the same (source_path, row_kind, source_hash,
 *     extraction_version) as the row half, plus the lane. An edit (new hash) or
 *     an extraction_version bump invalidates it exactly as it invalidates a
 *     row, and a zero-yield FACT lane can never suppress the event or
 *     preference lanes on the same bytes.
 *   - `max_rows_written` is the largest number of rows a COMPLETED run's
 *     adjudicated writes returned for this key. It is a value of the run, never a
 *     read of `structured_rows`, so no other connection's commit can tear it (the
 *     first revision stored a row count and the primary review confirmed that
 *     hole as B1 at head aeb388e). It is ALSO monotone — the upsert never lowers
 *     it — because two concurrent runs can legitimately disagree about the same
 *     bytes (the extractor is a model), and the later-finishing run must not be
 *     able to erase a positive outcome with a zero (B1 at head 9397d50, the same
 *     attack surviving the first fix).
 *   - ONLY `max_rows_written = 0` is a skip, and only with no CURRENT row for the
 *     key (re-checked live in the same statement). A run that wrote anything, or
 *     that left a row later CLOSED or deleted by an edit, must still be
 *     re-extracted: the row half has to stay live.
 *
 * So 0 means "completed runs for these bytes never wrote a row and nothing is
 * current" — the exact "left nothing current" predicate, which also covers a run
 * whose candidates were ALL gate-blocked as `sensitive`. That decision is made
 * from the candidate text alone, so its zero is true: nothing will ever be stored
 * for those bytes. An extractor-yield marker would instead miss exactly those
 * notes and re-call the extractor AND the per-candidate capture-gate decision on
 * every pass forever, which is #189's own symptom.
 *
 * Direction of all the asymmetry: a wrong skip can silently drop a note's rows
 * forever, while a wrong non-skip costs one repeat extraction. Every ambiguity
 * here is therefore resolved toward re-extraction.
 */

export type LaneRowKind = 'fact' | 'event' | 'preference';

/**
 * A presence-only cache handle: non-null means "this lane's last completed run
 * on these bytes produced nothing, and nothing is current for them, so there is
 * no extraction work to do". It is not a `structured_rows` row and nothing may
 * read an id from it.
 */
export interface LaneZeroYieldHit {
  readonly laneZeroYield: true;
}

export function laneZeroYieldMarker(
  db: Database.Database,
  sourcePath: string,
  rowKind: LaneRowKind,
  sourceHash: string,
  extractionVersion: string,
): LaneZeroYieldHit | undefined {
  // The run fact alone is not enough: a concurrent writer for the SAME note
  // (the watcher indexing while a CLI index runs) can have inserted a row since
  // that run finished, and a live row must always outrank a marker. The row
  // half is therefore re-checked live, in this same statement, so the decision
  // is one atomic read of both halves. Extra extraction in that race is the
  // safe direction; serving an empty lane is not.
  const row = db.prepare(
    `SELECT max_rows_written FROM lane_runs
     WHERE source_path = ? AND row_kind = ? AND source_hash = ? AND extraction_version = ?
       AND max_rows_written = 0
       AND NOT EXISTS (
         SELECT 1 FROM structured_rows r
         WHERE r.source_path = lane_runs.source_path AND r.row_kind = lane_runs.row_kind
           AND r.source_hash = lane_runs.source_hash AND r.extraction_version = lane_runs.extraction_version
           AND r.valid_to IS NULL
       )
     LIMIT 1`,
  ).get(sourcePath, rowKind, sourceHash, extractionVersion) as { max_rows_written: number } | undefined;
  if (!row) return undefined;
  return { laneZeroYield: true };
}

/**
 * Record a completed lane run. Called after the lane's extractor and its
 * adjudicated writes returned without throwing — one row per (note, lane,
 * content-version), refreshed in place on a repeat run.
 *
 * One statement, deliberately NOT wrapped in a transaction: the only value
 * written is `rowsWritten`, an argument of this call, so there is no
 * read-modify-write window to protect. (The MAX in the upsert is evaluated by
 * SQLite inside the statement.) Wrapping it in a default (deferred)
 * better-sqlite3 transaction would add a WAL snapshot-upgrade window
 * (SQLITE_BUSY_SNAPSHOT) against the very cross-process writer this marker is
 * defensive about — a failure introduced in the race instead of closed.
 */
export function recordLaneRun(
  db: Database.Database,
  sourcePath: string,
  rowKind: LaneRowKind,
  sourceHash: string,
  extractionVersion: string,
  rowsWritten: number,
): void {
  // Monotone on purpose: max(stored, this run). A zero can never erase a
  // positive record for the same key, whichever run finishes last.
  db.prepare(
    `INSERT INTO lane_runs
       (source_path, row_kind, source_hash, extraction_version, max_rows_written, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path, row_kind, source_hash, extraction_version) DO UPDATE SET
       max_rows_written = max(lane_runs.max_rows_written, excluded.max_rows_written),
       completed_at = excluded.completed_at`,
  ).run(
    sourcePath,
    rowKind,
    sourceHash,
    extractionVersion,
    rowsWritten,
    new Date().toISOString(),
  );
}
