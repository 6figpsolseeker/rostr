/**
 * Who may see the operator view.
 *
 * ## This is not an admin role, and the distinction is the whole point
 *
 * `CLAUDE.md` says plainly: *"If you find yourself adding an 'isAdmin'
 * parameter, that is the thing this project exists to remove."* That rule is
 * about **league** operations — deciding a trade, adjusting a score, naming a
 * winner — and it stands. Nothing here gets a caller any power inside a league.
 *
 * What this gates is *observation of the data pipeline*: which games the stats
 * translator flagged as internally contradictory, and whether their week has
 * finalised yet. It answers "is the provider sending us nonsense", which is a
 * question about our supplier rather than about anybody's fantasy team.
 *
 * So it is deliberately shaped to be useless for anything else:
 *
 * - it returns a **boolean about the signed-in user**, never a parameter a
 *   caller can pass. There is no `asOperator` argument to forget to check.
 * - nothing in `@rostr/core` or `@rostr/db` imports it. It cannot reach a rule,
 *   a lineup, a trade or a score, because those packages do not know it exists.
 * - it is checked at the page and the route, not threaded into a domain
 *   function. A future league feature that wants an exception has to add its
 *   own gate, visibly, rather than reusing this one.
 *
 * ## Fails closed, and unset means nobody
 *
 * `OPERATOR_EMAILS` unset is not "everyone" and not "development is open" — it
 * is **nobody**, in every environment. `cronForbidden` next door relaxes in
 * development because a cron route does nothing a developer cannot already do
 * by hand; this one shows production data about real games, so the same
 * relaxation would make a local `.env` a key to it.
 *
 * That direction costs an unset deployment a blank page, which is visible and
 * fixable in a minute. The other direction is a stranger reading the ingest
 * health of every game in the system.
 */

/** Emails permitted to see the operator view. Empty when unset — see above. */
export function operatorEmails(
  raw: string | undefined = process.env["OPERATOR_EMAILS"],
): readonly string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether this signed-in email is an operator.
 *
 * Compared lower-cased and trimmed on both sides, because the allowlist is
 * typed into a deployment console by a human and `Brian@Example.com ` is the
 * same person as `brian@example.com`. The local part of an address is
 * technically case-sensitive; treating it otherwise is the safer error here,
 * since the failure it prevents is an operator locked out of their own
 * diagnostics and the failure it risks is an operator matching an address they
 * also control.
 *
 * `null` — nobody signed in — is never an operator. Stated rather than left to
 * fall out of the comparison, because a signed-out visitor reaching this is the
 * case most likely to be wrong.
 */
export function isOperator(
  email: string | null | undefined,
  allowlist: readonly string[] = operatorEmails(),
): boolean {
  if (typeof email !== "string") return false;
  const normalised = email.trim().toLowerCase();
  if (normalised.length === 0) return false;
  return allowlist.includes(normalised);
}
