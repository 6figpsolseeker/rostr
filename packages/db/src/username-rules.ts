/**
 * What makes a username legal. Pure, and importable from a browser.
 *
 * **This file must import nothing.** It is reached from a client component
 * through the `@rostr/db/username-rules` subpath, and the whole reason that
 * subpath exists is that `@rostr/db`'s main entry pulls in `identity.ts`, which
 * needs `node:crypto` — a module webpack cannot bundle for a browser at all.
 * That failure does not show up in `tsc`; it shows up as a broken production
 * build, which is how it was found. Same shape as `@rostr/db/migrate`, which is
 * separate because it reads SQL from disk.
 *
 * The rules live here rather than being written twice so the form and the server
 * cannot disagree. A client-side copy would drift, and the symptom would be a
 * form that happily accepts a name the API then refuses.
 */

/**
 * Three to twenty characters, starting with a letter.
 *
 * The leading letter is what keeps a username distinguishable from everything
 * else that might sit in the same field. A name that is only digits reads as an
 * id, and this repo already puts UUIDs in URLs; `12345` in an invite box should
 * be an error rather than a lookup that mysteriously finds nobody.
 *
 * Mirrored by the `users_username_shape` CHECK in migration `0035`. If you
 * loosen one, loosen the other in the same commit.
 */
export const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/**
 * Names nobody may claim.
 *
 * Two kinds, and both matter. The first is impersonation — a member called
 * `rostr` or `support` in a league is a phishing attempt with no effort behind
 * it. The second is routing: these are path segments the app already uses, and a
 * username colliding with one is a trap for whoever later decides `/@name`
 * should work.
 */
const RESERVED = new Set([
  "admin",
  "administrator",
  "api",
  "commissioner",
  "help",
  "invitations",
  "leagues",
  "login",
  "logout",
  "moderator",
  "new",
  "official",
  "ops",
  "root",
  "rostr",
  "scoring",
  "settings",
  "signin",
  "signout",
  "signup",
  "support",
  "system",
  "team",
  "undefined",
  "welcome",
  "null",
]);

export type UsernameProblem =
  "TOO_SHORT" | "TOO_LONG" | "BAD_SHAPE" | "RESERVED" | "ALL_DIGITS";

/**
 * What is wrong with this username, or `null` if nothing is.
 *
 * Returns the problem rather than throwing, so a form can show it as the person
 * types. The order is deliberate: length first, because "too short" is the
 * commonest and the most actionable message, and shape only after — telling
 * somebody who typed `ab` about the permitted character set is answering a
 * question they did not ask.
 */
export function usernameProblem(raw: string): UsernameProblem | null {
  const name = raw.trim();

  if (name.length < USERNAME_MIN) return "TOO_SHORT";
  if (name.length > USERNAME_MAX) return "TOO_LONG";
  if (/^\d+$/.test(name)) return "ALL_DIGITS";
  if (!USERNAME_PATTERN.test(name)) return "BAD_SHAPE";
  if (RESERVED.has(name.toLowerCase())) return "RESERVED";

  return null;
}

/** The same rules, as a sentence somebody can act on. */
export function usernameProblemMessage(problem: UsernameProblem): string {
  switch (problem) {
    case "TOO_SHORT":
      return `At least ${USERNAME_MIN} characters.`;
    case "TOO_LONG":
      return `At most ${USERNAME_MAX} characters.`;
    case "ALL_DIGITS":
      return "Needs at least one letter — a number on its own reads as an id.";
    case "BAD_SHAPE":
      return "Letters, numbers and underscores, starting with a letter.";
    case "RESERVED":
      return "That one is reserved.";
  }
}
