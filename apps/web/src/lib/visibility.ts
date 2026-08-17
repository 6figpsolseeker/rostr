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

/**
 * Whether the league-scoped tabs will actually open for this viewer.
 *
 * **Derived from the gate, never a second copy of the rule.** The nav and the
 * 404 have to agree, and this repo has twice been bitten by one rule
 * implemented in two places — the trade deadline computed separately in
 * `proposeTrade` and `resolveDueTrades`, and the lineup lock computed from a
 * roster map in both the screen and the server. Re-deriving "is this person a
 * member" from `visibility` and a wallet row would be the same mistake a third
 * time, and its failure mode is a nav that offers doors the gate refuses.
 *
 * **Deliberately not named `leagueReadAccess`, and not a re-export.**
 * `/leagues/[id]/page.tsx` is one of the two files that must never refuse
 * anybody — `RULES.md` requires the full rule set to be readable before someone
 * joins, and an invitee is by definition not yet a member. That file is listed
 * in `OPEN` in `league-read.test.ts`, and `/leagueReadAccess\(/` is one of that
 * sweep's `GATES` patterns. Calling the gate directly from the entrance would
 * put a gate's name in a file that does not gate — which is exactly the shape
 * that test exists to catch, and would silently certify the entrance the day
 * anybody removed its `OPEN` entry.
 */
export async function leagueNavOpen(leagueId: string): Promise<boolean> {
  return (await leagueReadAccess(leagueId)).ok;
}
