import "server-only";

import { getLeagueRules, teamForUser } from "@rostr/db";
import { db } from "./db";
import { currentUser } from "./session";

/**
 * Whether this viewer may read this league.
 *
 * `league.visibility` is part of the **frozen, hashed, member-signed** rule set
 * (`packages/core/src/rules/types.ts`), and until now nothing read it back. It
 * was written to the `leagues` row at creation and never consulted again — every
 * other occurrence in the repo is a test.
 *
 * That is the same defect `botsAllowed` was removed for: a guarantee members
 * signed that did nothing. A rule set that says PRIVATE while the standings,
 * the draft board and every team's bench are readable by anyone holding a URL is
 * making a promise the code does not keep, and the URL is not a secret — it is
 * in browser history, in screenshots, and in whatever chat the invite was pasted
 * into.
 *
 * ## What this does not gate
 *
 * **The league page itself stays open.** `RULES.md` and `CLAUDE.md` both require
 * the full rule set to be shown before anyone joins, and an invitee is by
 * definition not yet a member. Gating the page would make "shown before you
 * join" impossible to satisfy for the private leagues that are the whole point
 * of an invite link. What is gated is everything that reports how the league is
 * *going* — standings, the draft, the scoreboard, the bracket.
 *
 * **PUBLIC leagues are not gated at all.** The league list already publishes
 * their ids (`/api/leagues`), and being findable is what public means.
 *
 * ## Read from the rules, not the column
 *
 * `leagues.visibility` is a denormalised copy written at creation. The frozen
 * document is what members signed, so it is the authority — and reading the copy
 * would mean a future bug in that write could quietly open a private league.
 */
export type LeagueReadAccess =
  | { readonly ok: true; readonly isMember: boolean }
  | { readonly ok: false; readonly reason: "NOT_FOUND" | "PRIVATE" };

export async function leagueReadAccess(leagueId: string): Promise<LeagueReadAccess> {
  const client = db();

  const stored = await getLeagueRules(client, leagueId);
  if (!stored) return { ok: false, reason: "NOT_FOUND" };

  const user = await currentUser();
  const team = user ? await teamForUser(client, leagueId, user.id) : null;
  const isMember = team !== null;

  if (isMember || stored.rules.league.visibility !== "PRIVATE") {
    return { ok: true, isMember };
  }

  return { ok: false, reason: "PRIVATE" };
}
