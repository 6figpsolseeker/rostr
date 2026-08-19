/**
 * Usernames — the name a commissioner can type to invite you.
 *
 * Kept out of `identity.ts` because that file is about proving who somebody is
 * — codes, sessions, wallet signatures — and this is about naming them. The
 * rules here are a product decision with no security weight: getting one wrong
 * costs somebody a second attempt at a form, not an account.
 *
 * **The rules themselves live in `username-rules.ts`**, which imports nothing
 * and is reachable from a browser through `@rostr/db/username-rules`. This
 * module needs a database and `identity.ts`, and `identity.ts` needs
 * `node:crypto` — which webpack cannot bundle for a client component at all.
 * The form validates with the same function the server does; it simply reaches
 * it by the door that has no Node in it.
 */

import type { SqlClient } from "./client.js";
import { IdentityError } from "./identity.js";
import { isUniqueViolation } from "./pg-errors.js";
import { usernameProblem, usernameProblemMessage } from "./username-rules.js";

export * from "./username-rules.js";
/**
 * Claim or change a username.
 *
 * **Changing is allowed**, and that is safe because nothing stores a username as
 * a reference: an invitation resolves the name to a user id when it is written,
 * so renaming yourself afterwards leaves every existing invitation pointing at
 * the same person. If something ever does store the string, this becomes a
 * decision rather than a detail.
 *
 * Uniqueness is checked and then enforced by the index, in that order and for
 * the reason `linkWallet` gives: the check gives a usable error, the index is
 * what is actually true. Two tabs claiming the same name at the same instant
 * both pass the check, and the loser must not surface as a raw constraint
 * violation.
 */
export async function setUsername(db: SqlClient, userId: string, raw: string): Promise<string> {
  const name = raw.trim();

  const problem = usernameProblem(name);
  if (problem) {
    throw new IdentityError(usernameProblemMessage(problem), "INVALID_USERNAME");
  }

  const [claimed] = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE lower(username) = lower($1)",
    [name],
  );
  // Re-claiming your own name in different capitals is a rename, not a clash.
  if (claimed && claimed.id !== userId) {
    throw new IdentityError("That username is taken", "USERNAME_TAKEN");
  }

  try {
    await db.query("UPDATE users SET username = $2 WHERE id = $1", [userId, name]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new IdentityError("That username is taken", "USERNAME_TAKEN");
    }
    throw error;
  }

  return name;
}

/**
 * Find somebody by the name a commissioner typed.
 *
 * Case-insensitive, because the entire purpose of a username is that it
 * survives being repeated by a person. Returns `null` rather than throwing —
 * "no such user" is an ordinary outcome of a typed field, and the caller is
 * better placed to say what it means.
 */
export async function findUserByUsername(
  db: SqlClient,
  raw: string,
): Promise<{ id: string; username: string } | null> {
  const name = raw.trim();
  if (name === "") return null;

  const [row] = await db.query<{ id: string; username: string }>(
    "SELECT id, username FROM users WHERE lower(username) = lower($1)",
    [name],
  );
  return row ?? null;
}

/** Whether a name is free for this user to take. Powers the form's live check. */
export async function usernameAvailable(
  db: SqlClient,
  userId: string,
  raw: string,
): Promise<boolean> {
  if (usernameProblem(raw) !== null) return false;
  const owner = await findUserByUsername(db, raw);
  return owner === null || owner.id === userId;
}
