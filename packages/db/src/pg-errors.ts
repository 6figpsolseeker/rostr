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
