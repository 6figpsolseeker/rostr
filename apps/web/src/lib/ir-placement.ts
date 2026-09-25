/**
 * Whether this player's own game has started, as `moveToIr` asks the question.
 *
 * ## Why this is not the lineup lock, and must never be merged with it
 *
 * There are two kickoff rules in this product and they deliberately disagree
 * about the same player.
 *
 * The **lineup lock** — `RULES.md` §2, "each slot locks individually at the
 * kickoff of that player's game" — fails **closed**. `loadKickoffs` hands a
 * player whose club appears in no fixture the week's first kickoff rather than
 * null, so his slot freezes when the week begins. That is what stops the lock
 * being defeated by cutting the man standing in a locked slot.
 *
 * **Injured reserve** fails **open** for the same player, and that is also
 * correct. §2's IR paragraph attaches no kickoff condition and no club
 * condition — the test is a designation test, and it states its own tie-break:
 * "a designation nobody here recognises admits him rather than refusing. That
 * direction is chosen." So `heldRoster` LEFT JOINs the same fixture, finds
 * nothing, leaves `kickoff_at` NULL, and `moveToIr` **accepts** the placement.
 *
 * Two rules, two answers, not a bug. The defect in #321 was that this screen
 * borrowed the lineup-lock answer to predict the IR rule.
 *
 * ## How it reconstructs the server's predicate exactly
 *
 * `opponentRef` is the flag that tells the two apart. `loadRosterForWeek`
 * derives it from the **character-identical** `LEFT JOIN games` that
 * `heldRoster` uses, and `lineups.ts` notes "Both refs are present or neither
 * is" — so `opponentRef !== null` holds exactly when the server sees a kickoff,
 * and when it does, both sides hold the same `g.kickoff_at`. `heldRoster`
 * states that agreement in prose: "Deriving it here a second way is how the two
 * would come to disagree about which game a player is in."
 *
 * The second conjunct covers a `games` row that exists with a null
 * `kickoff_at`: refs present, kickoff absent. The server's `player?.kickoff_at`
 * is falsy there, so it accepts, and so does this.
 *
 * ## Do not "fix" the first branch
 *
 * Returning `false` for a clubless player looks like a missing fail-closed
 * guard and reads as a bug to anyone who knows `loadKickoffs`. It is the point.
 * Reading `kickoffAt` alone here would hide the button for exactly the players
 * the server would accept — worse than the 409 it removes, and unreportable:
 * the manager sees nothing and has nothing to describe. `ir-placement.test.ts`
 * pins it.
 *
 * Named for the refusal code it predicts — `moveToIr` throws `GAME_STARTED` —
 * rather than for a fact about the world. A predicate called `kickedOff` or
 * `hasPlayed` is one two different rules can both plausibly claim, which is how
 * the fail-open and fail-closed answers collapse back into one.
 */
export function irGameStarted(
  player: { readonly opponentRef: string | null; readonly kickoffAt: number | null },
  now: number,
): boolean {
  if (player.opponentRef === null) return false;
  return player.kickoffAt !== null && now >= player.kickoffAt;
}
