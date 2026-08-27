import type { ProviderInjury, StatsProvider } from "@rostr/stats";
import type { SqlClient } from "./client.js";

/**
 * Designations recorded in `docs/TANK01.md`, with counts and a capture date.
 *
 * Not a rule — `isIrEligible` is a deny-list and admits anything not in its own
 * small set, deliberately. This is the evidence register: a value absent here
 * is one nobody has written down, and the warning below is how the next one
 * gets noticed.
 */
const RECORDED_DESIGNATIONS = new Set(["QUESTIONABLE", "INJURED RESERVE", "OUT", "DOUBTFUL"]);

/**
 * Report designations this project has not seen before.
 *
 * The vocabulary decides a rule and belongs to somebody else. It was guessed
 * once — seven short codes against a column holding `"Injured Reserve"` — and the
 * guess refused the players injured reserve exists for, silently, for as long
 * as it took an agent to read the code. Issue 251.
 *
 * So the deny-list is deliberately permissive and this is the other half: an
 * unfamiliar designation is admitted, and said out loud. Aggregated by distinct
 * value rather than per player, because a new word on 200 rosters is one fact.
 *
 * Mirrors `mapGameStatus`'s warning in the Tank01 adapter, for the same reason:
 * an operator gets told, rather than a wrong answer being written every hour
 * without comment.
 */
function reportUnrecordedDesignations(injuries: readonly ProviderInjury[]): void {
  const unrecorded = new Map<string, number>();
  for (const injury of injuries) {
    const value = injury.designation.trim();
    if (value === "") continue;
    if (RECORDED_DESIGNATIONS.has(value.toUpperCase())) continue;
    unrecorded.set(value, (unrecorded.get(value) ?? 0) + 1);
  }

  for (const [value, count] of unrecorded) {
    // eslint-disable-next-line no-console
    console.warn(
      `[injuries] unrecorded injury designation ${JSON.stringify(value)} on ${count} ` +
        `player(s). It is being treated as injured, which is this rule's safe ` +
        `direction. Record it verbatim in docs/TANK01.md, and add it to ` +
        `MAY_STILL_PLAY in packages/core if it means the player may still appear.`,
    );
  }
}
/**
 * Keep injury designations current between player syncs.
 *
 * `season-sync` runs **once a day**, at 09:20 UTC. It carries designations along
 * with everything else, so a player ruled out on a Sunday morning would not
 * reach a manager until the following morning — after his game, after the lock,
 * after the week was scored. `docs/LIVE-SCORING.md` argues this is the timely
 * feed that matters most, on the grounds that it changes what somebody *does*
 * where a live score only changes what they watch.
 *
 * This is the same provider endpoint the daily sync reads, so it is **not a
 * fresher source** — Tank01 refreshes rosters hourly and this cannot beat that.
 * What it changes is our own cadence, from a day to whatever the schedule says.
 * That is the whole of the improvement and the docstring should not imply more.
 *
 * ## It writes exactly three columns
 *
 * Designation, description, return date. Not the name, the club, the headshot or
 * anything else the player sync owns. A frequent job that touched everything
 * would be a second writer for every profile column, racing the daily one and
 * costing a full upsert per player per run.
 */

export interface InjurySyncResult {
  /** Players whose designation was set or changed. */
  readonly designated: number;
  /** Players whose designation was cleared because they no longer carry one. */
  readonly cleared: number;
  /**
   * How many rows the provider returned, before anything was applied.
   *
   * Reported separately from `designated` because **zero returned and zero
   * changed are different facts**. A quiet hour in which nobody's status moved
   * is the ordinary state of this job and must read as healthy; a provider
   * returning nothing at all is a broken response wearing the same face, and it
   * is the one worth waking somebody for.
   */
  readonly providerReturned: number;
}

/**
 * Apply the provider's current injury list.
 *
 * **The list is a complete snapshot, and clearing is the half that is easy to
 * miss.** `listInjuries()` filters to players who *have* a designation, so a
 * player who recovers simply stops appearing — he is not returned with a null.
 * A sync that only applied the rows it received could therefore never clear
 * anything, and every player ever designated would read "Out" for the rest of
 * the season.
 *
 * That is not a cosmetic bug any more. `isIrEligible` reads this column, so a
 * stale designation would keep a healthy player on injured reserve and exempt
 * from the roster limit **indefinitely** — the exact hole the owner's rule
 * ("whenever a player is on IR they need to be actually injured") exists to
 * close, reopened from the ingest side.
 *
 * So absence here means "not injured", and it is safe to read it that way for
 * one specific reason: this is a single-source snapshot of one sport's whole
 * player list, not a partial update. **If a second provider is ever added, this
 * must not simply run twice** — two snapshots would each clear what the other
 * asserted. That is the same "absent is not an assertion" problem
 * `syncPlayers` already solves with its `hasProfile` gate, and the answer here
 * would have to be a source column rather than a second call.
 *
 * The clear is scoped to the sport, so a future sport's designations cannot be
 * wiped by football's snapshot.
 */
export async function syncInjuries(
  db: SqlClient,
  provider: StatsProvider,
  sportKey: string,
): Promise<InjurySyncResult> {
  const [sport] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    sportKey,
  ]);
  if (!sport) throw new Error(`Unknown sport: ${sportKey}`);

  const injuries = await provider.listInjuries();

  /*
    An empty list is refused rather than applied.

    A provider returning nothing is far more likely to be a bad response, an
    auth failure that answered 200, or a schema change than it is to be a week
    in which no player in the NFL is injured. Applying it would clear every
    designation in the database at once — and, through `isIrEligible`, silently
    empty every injured reserve in every league.

    A stale designation costs one manager one wrong badge. A mass clear costs
    every league its roster accounting, and nothing would report it.
  */
  if (injuries.length === 0) {
    return { designated: 0, cleared: 0, providerReturned: 0 };
  }
  reportUnrecordedDesignations(injuries);

  const designated = await db.query<{ external_ref: string }>(
    `UPDATE players AS p
        SET injury_designation = v.designation,
            injury_description = v.description,
            updated_at = now()
       FROM (
         SELECT unnest($2::text[]) AS external_ref,
                unnest($3::text[]) AS designation,
                unnest($4::text[]) AS description
       ) AS v
      WHERE p.sport_id = $1
        AND p.external_ref = v.external_ref
        AND (p.injury_designation IS DISTINCT FROM v.designation
             OR p.injury_description IS DISTINCT FROM v.description)
      RETURNING p.external_ref`,
    [
      sport.id,
      injuries.map((injury) => injury.externalRef),
      injuries.map((injury) => injury.designation),
      injuries.map((injury) => injury.description),
    ],
  );

  const cleared = await db.query<{ external_ref: string }>(
    `UPDATE players
        SET injury_designation = NULL,
            injury_description = NULL,
            injury_return_date = NULL,
            updated_at = now()
      WHERE sport_id = $1
        AND injury_designation IS NOT NULL
        AND NOT (external_ref = ANY($2::text[]))
      RETURNING external_ref`,
    [sport.id, injuries.map((injury) => injury.externalRef)],
  );

  return {
    designated: designated.length,
    cleared: cleared.length,
    providerReturned: injuries.length,
  };
}
