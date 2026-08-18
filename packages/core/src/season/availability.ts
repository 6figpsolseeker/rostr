/**
 * Why a player has no game this week.
 *
 * ## The distinction this exists to make
 *
 * A missing `games` row has always read as "bye" everywhere it surfaces, and for
 * most of the season that is correct. It stops being correct at exactly the
 * point it matters most.
 *
 * The NFL fixes the kickoff *times* of its late-December games last, holding
 * them back for flex scheduling. Verified against the provider on 2026-08-17:
 * Tank01 returns every one of those fixtures with `gameDate` set and
 * `gameTime: "TBD"`, `gameTime_epoch: ""` — the **day is known and the hour is
 * not**. `syncGames` skips a game with no kickoff time deliberately, since
 * storing a zero would lock lineups at the epoch, and that leaves a team which
 * is playing looking identical to a team that is resting.
 *
 * Those are opposite facts for a manager. A bye means "start someone else, this
 * player cannot score". A fixture awaiting its kickoff time means "this player
 * will play, and nobody has said at what hour" — the same player, a decision
 * reversed, in the week a season is won.
 *
 * ## Two states, because there are two situations
 *
 * `syncGames` now stores such a fixture with `kickoff_tbd` set and a
 * conservative kickoff taken from its dated siblings, so the ordinary case has a
 * row and answers **`TIME_TBD`** — the screen can name the date and the
 * opponent, and say the hour is pending.
 *
 * **`UNSCHEDULED` is what remains when even that fails**: no row at all, on a
 * week that is not the team's bye. Reachable when every game on a date is
 * untimed, so no stand-in could be derived, or when the sync has not run. It
 * says a fixture is coming without being able to name when or against whom,
 * which is worth saying and is strictly less than `TIME_TBD` says.
 *
 * ## The bye week is what separates them
 *
 * Every team's bye is stored (`player_seasons.bye_week`), frozen long before the
 * season, and never one of the late weeks where dating is outstanding. So the
 * two cases are told apart with data already held rather than anything new:
 *
 *   - a game this week → `SCHEDULED`, whatever else is true
 *   - no game, and this **is** the team's bye → `BYE`
 *   - no game, and the team's bye is elsewhere → `UNSCHEDULED`
 *
 * ## Not knowing the bye week reads as a bye
 *
 * `UNSCHEDULED` is claimed only when the bye week is known **and** falls in a
 * different week. An unknown bye — a player with no `player_seasons` row, a
 * free agent, a provider gap — keeps today's answer.
 *
 * That direction is deliberate. `UNSCHEDULED` tells a manager to hold a roster
 * spot for a game that is coming; inferring it from absent data would invent
 * that promise out of a gap in our own ingest. A wrong `BYE` costs one player's
 * week, and is what already happens today; a wrong `UNSCHEDULED` is the screen
 * asserting something nobody told it.
 *
 * ## It decides nothing
 *
 * This is a label, never a lock and never a score. `loadKickoffs` remains the
 * only definition of when a slot freezes, and an unscheduled game has no kickoff
 * to freeze on — so an `UNSCHEDULED` player is movable, exactly as a bye player
 * is, and scores zero if the week ends without his game. Widening the lock to
 * cover this case would need a kickoff time, which is the one thing that does
 * not exist yet.
 */

/** Why a player's week is empty, or when it is not quite settled. */
export type GameAvailability = "SCHEDULED" | "TIME_TBD" | "BYE" | "UNSCHEDULED";

export interface GameAvailabilityInput {
  /** Kickoff of this player's game this week, or null when there is no row. */
  readonly kickoffAt: number | Date | null;
  /**
   * The stored kickoff is a conservative stand-in, not the real time.
   *
   * `games.kickoff_tbd`. The fixture and its date are known; the hour is not.
   */
  readonly kickoffTbd?: boolean;
  /** The player's team's bye week this season. Null when it is not known. */
  readonly byeWeek: number | null;
  /** The week being asked about. */
  readonly week: number;
}

/**
 * Whether this player's week is a bye, a fixture awaiting its kickoff time, or
 * an ordinary game.
 *
 * Takes the bye week rather than a roster or a team so the rule stays pure and
 * one implementation serves both the scoreboard and the lineup editor. Two
 * screens disagreeing about whether a player is on a bye is the kind of split
 * that sends a manager to the wrong decision.
 */
export function gameAvailability(input: GameAvailabilityInput): GameAvailability {
  // A stored fixture whose hour is provisional. Ranked above `SCHEDULED`
  // because the row does carry a timestamp and it must not be read as one.
  if (input.kickoffAt !== null && input.kickoffTbd === true) return "TIME_TBD";
  if (input.kickoffAt !== null) return "SCHEDULED";
  if (input.byeWeek === null) return "BYE";
  return input.byeWeek === input.week ? "BYE" : "UNSCHEDULED";
}
