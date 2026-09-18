/**
 * Postgres error codes this package reacts to.
 *
 * Kept in one place because "did we lose a race?" is asked from more than one
 * module now — the draft, and free agency — and two copies of the predicate is
 * two chances for one of them to widen quietly.
 */

/**
 * Postgres `unique_violation` (23505).
 *
 * Narrow deliberately: a unique violation means a constraint arbitrated between
 * two writers, and nothing else. Any other error is a real fault and must
 * surface as itself rather than be relabelled as contention — so callers should
 * wrap the single statement whose uniqueness they mean, not a whole transaction.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Postgres `deadlock_detected` (40P01).
 *
 * Postgres resolves a lock cycle by aborting one of the transactions in it, and
 * the survivor commits. For a transaction whose every write is safe to re-read
 * and redo, that abort is contention in the same sense as a unique violation.
 * Retry only such transactions — see `signInWithPrivy`.
 */
export function isDeadlock(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "40P01"
  );
}

/**
 * Postgres `undefined_table` (42P01).
 *
 * The one error that genuinely means "nothing has ever run here". `db:status`
 * used to swallow *every* failure into an empty applied-set, so an unreachable
 * database, a permission problem and a wrong connection string all rendered as
 * "every migration is pending" — the loudest possible wrong answer, and
 * indistinguishable from a database that is merely new. This is what lets the
 * one benign case stay benign while the rest are reported.
 */
export function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}
