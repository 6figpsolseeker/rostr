/**
 * Season projections.
 *
 * `getNFLProjections` with **no `week` parameter** returns full-season totals —
 * confirmed live on 2026-08-06: `body.week` comes back as the string `"season"`,
 * and the magnitudes agree (Ja'Marr Chase 1457 receiving yards on 121 catches,
 * Jahmyr Gibbs 1231 rushing). Passing a week returns that week alone.
 *
 * One call covers 622 players and all 32 team defenses.
 *
 * ## The shape is not the box score shape
 *
 * Verified differences, each of which broke a first attempt at this elsewhere in
 * the codebase:
 *
 *   * `fumblesLost` sits at the **top level**, not under `Defense` as it does in
 *     a box score.
 *   * `twoPointConversion` exists as a real field here. In actuals it has to be
 *     parsed out of scoring plays.
 *   * `fantasyPointsDefault` is Tank01's own scoring. **Ignored deliberately.**
 *     Every league scores raw stats against its own frozen rules, and ours pays
 *     4 points for a passing touchdown where most defaults pay 4 or 6 depending
 *     on the format. Showing a provider's number next to a league's real scoring
 *     would be quietly wrong.
 *
 * ## Projections are fractional; stats are not
 *
 * A projection of 63.9 receptions is meaningful as an estimate. The scoring
 * engine takes whole units by design, so values are **rounded** on the way in.
 * The rounding error is far smaller than the uncertainty already in a
 * projection, and keeping the engine integer-only matters more.
 */

import type { StatLine } from "@rostr/core";
import { parseStatValue } from "./stat-map.js";

/** Projected season totals for one player or team defense. */
export interface ProviderProjection {
  readonly externalRef: string;
  readonly fullName: string;
  /** Registry position key — "QB", "WR", "DEF". */
  readonly position: string;
  readonly teamRef: string | null;
  readonly stats: readonly StatLine[];
}

/**
 * Projection field paths to our stat keys.
 *
 * Deliberately its own map rather than a reuse of `TANK01_STAT_MAP`: the shapes
 * genuinely differ, and sharing one map would mean a change for box scores
 * silently altering projections or the reverse.
 */
const PLAYER_FIELDS: Readonly<Record<string, string>> = {
  "Passing.passYds": "pass_yd",
  "Passing.passTD": "pass_td",
  "Passing.int": "pass_int",

  "Rushing.rushYds": "rush_yd",
  "Rushing.rushTD": "rush_td",

  "Receiving.recYds": "rec_yd",
  "Receiving.recTD": "rec_td",
  "Receiving.receptions": "rec",

  // Top level here. Under `Defense` in a box score.
  fumblesLost: "fum_lost",

  // A field in projections; parsed from scoring plays in actuals.
  twoPointConversion: "two_pt",

  "Kicking.xpMade": "xp_made",

  /**
   * **Kicker projections are a floor, and the UI says so.**
   *
   * Our scoring pays 3, 4, or 5 points by distance. Tank01 projects only a total
   * `fgMade` — 27.1 — with no distance split, so every projected field goal is
   * counted in the 3-point tier.
   *
   * That understates a kicker by roughly the share of his kicks from 40+, but it
   * preserves the ordering *among kickers*, which is what a draft board needs,
   * and the board groups by position so kickers are never compared against
   * receivers. Inventing a distance distribution to look precise would be worse
   * than being visibly conservative.
   *
   * `fgMissed` and `xpMissed` are ignored: our rules do not penalise misses.
   */
  "Kicking.fgMade": "fg_0_39",
};

const DEFENSE_FIELDS: Readonly<Record<string, string>> = {
  sacks: "def_sack",
  interceptions: "def_int",
  fumbleRecoveries: "def_fum_rec",
  safeties: "def_safety",
  // `def_blk_kick`, not `def_block_kick`. Checked against the registry rather
  // than guessed — the first attempt at this line was wrong.
  blockKick: "def_blk_kick",
  ptsAgainst: "def_pts_allowed",
};

/**
 * Team touchdown fields that both score as the unit's touchdown.
 *
 * `docs/RULES.md` §1 pays 6 for a "defensive **or special teams** touchdown", so
 * a kick return taken to the end zone by the unit counts the same as a pick six.
 * Tank01 reports them separately, so they are summed.
 *
 * Not to be confused with `ret_td`, which is the *individual returner's* six
 * points and belongs to a different roster spot.
 */
const DEFENSE_TOUCHDOWN_FIELDS = ["defTD", "returnTD"] as const;

function read(source: Record<string, unknown>, path: string): number | null {
  const parts = path.split(".");
  let cursor: unknown = source;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }

  const parsed = parseStatValue(cursor);
  return parsed === null ? null : parsed;
}

/**
 * Read a projected value.
 *
 * `parseStatValue` rejects fractions, which is right for actuals and wrong here,
 * so the raw string is parsed as a float and rounded.
 */
function readFloat(source: Record<string, unknown>, path: string): number | null {
  const parts = path.split(".");
  let cursor: unknown = source;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return null;
  const asNumber = typeof cursor === "number" ? cursor : Number.parseFloat(String(cursor));
  return Number.isFinite(asNumber) ? asNumber : null;
}

function readProjected(source: Record<string, unknown>, path: string): number | null {
  const value = readFloat(source, path);
  return value === null ? null : Math.round(value);
}

export interface RawProjectionsBody {
  playerProjections?: Record<string, Record<string, unknown>>;
  teamDefenseProjections?: Record<string, Record<string, unknown>>;
  week?: string | number;
  season?: string | number;
}

/** Positions Tank01 reports that our registry names differently. */
const POSITION_MAP: Readonly<Record<string, string>> = {
  PK: "K",
  FB: "RB",
};

/**
 * Translate a raw `getNFLProjections` body into provider projections.
 *
 * @param defenseRefPrefix how team-defense external refs are formed, so they
 *   match the synthesised DST players the player sync creates
 */
export function parseSeasonProjections(
  body: RawProjectionsBody,
  defenseRefPrefix: string,
): readonly ProviderProjection[] {
  const projections: ProviderProjection[] = [];

  for (const raw of Object.values(body.playerProjections ?? {})) {
    const externalRef = String(raw["playerID"] ?? "");
    if (!externalRef) continue;

    const reported = String(raw["pos"] ?? "");
    const position = POSITION_MAP[reported] ?? reported;

    const stats: StatLine[] = [];
    for (const [path, statKey] of Object.entries(PLAYER_FIELDS)) {
      const value = readProjected(raw, path);
      // Zero is dropped: a projection of zero passing yards for a receiver is
      // the absence of a projection, and the scoring engine treats absent as
      // "contributed nothing" either way.
      if (value !== null && value !== 0) stats.push({ statKey, value });
    }

    projections.push({
      externalRef,
      fullName: String(raw["longName"] ?? ""),
      position,
      teamRef: raw["team"] ? String(raw["team"]) : null,
      stats,
    });
  }

  for (const raw of Object.values(body.teamDefenseProjections ?? {})) {
    const teamAbv = String(raw["teamAbv"] ?? "");
    if (!teamAbv) continue;

    const stats: StatLine[] = [];
    for (const [field, statKey] of Object.entries(DEFENSE_FIELDS)) {
      const value = readProjected(raw, field);
      // `def_pts_allowed` is kept even at zero — the tiered rule needs a value,
      // and a defense projected to allow nothing would otherwise forfeit the
      // shutout tier rather than earn it.
      if (value !== null && (value !== 0 || statKey === "def_pts_allowed")) {
        stats.push({ statKey, value });
      }
    }

    // Summed *before* rounding. Rounding each first turns 1.2 and 0.3 into one
    // touchdown instead of two, and the same mistake across six stats is a
    // visibly wrong projection.
    const touchdowns = Math.round(
      DEFENSE_TOUCHDOWN_FIELDS.reduce(
        (total, field) => total + (readFloat(raw, field) ?? 0),
        0,
      ),
    );
    if (touchdowns !== 0) stats.push({ statKey: "def_td", value: touchdowns });

    projections.push({
      externalRef: `${defenseRefPrefix}${teamAbv}`,
      fullName: `${teamAbv} D/ST`,
      position: "DEF",
      teamRef: teamAbv,
      stats,
    });
  }

  return projections;
}

/** Whether a projections body really is the season aggregate. */
export function isSeasonAggregate(body: RawProjectionsBody): boolean {
  return String(body.week ?? "") === "season";
}

export { read as readProjectionField };
