/**
 * Regular season schedule generation.
 *
 * Head-to-head fantasy is a round robin. With an even number of teams the
 * **circle method** produces one: fix one team, rotate the rest around it, and
 * every team meets every other exactly once over `n - 1` weeks.
 *
 * A season is usually longer than one full rotation — 12 teams is 11 rounds
 * against 14 weeks — so the rotation simply continues, and the repeats fall in
 * the same order the first pass did. That keeps repeat matchups as evenly
 * spread as the length allows rather than clustering them.
 *
 * ## Odd leagues get byes
 *
 * A league can start with as few as two humans, and bots fill only at the
 * commissioner's discretion, so an odd number of teams is legal. The circle
 * method handles it by adding a phantom team; whoever is paired with it that
 * week has a bye.
 *
 * A bye in head-to-head is a real disadvantage — no opponent means no win — so
 * the rotation distributes them evenly and `byeCountsAreBalanced` exists to
 * prove it.
 */

import { sha256Hex } from "../canonical.js";

export interface ScheduledMatchup {
  readonly week: number;
  readonly homeTeamId: string;
  /** `null` means a bye: an odd league, and this team has no opponent. */
  readonly awayTeamId: string | null;
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

/** Phantom opponent used to make an odd league even. Never a real team ID. */
const BYE = Symbol("bye");
type Slot = string | typeof BYE;

/**
 * A deterministic starting rotation.
 *
 * The schedule is derived from a seed for the same reason the draft order is:
 * anyone holding the seed can recompute it and confirm nobody arranged an easy
 * run of opponents. Use the league's rules hash.
 */
function seededRotation(teamIds: readonly string[], seed: string): Slot[] {
  // Sort before shuffling. A shuffle permutes *positions*, so shuffling the
  // caller's array would make the schedule depend on the order teams were
  // passed in — and therefore on the order rows came back from the database.
  // Sorting first means the schedule depends only on the set of teams and the
  // seed, which is the property that makes it checkable.
  const slots: Slot[] = [...teamIds].sort();
  if (slots.length % 2 === 1) slots.push(BYE);

  // Fisher-Yates, driven entirely by the seed.
  for (let i = slots.length - 1; i > 0; i--) {
    const digest = sha256Hex(`${seed}:schedule:${i}`);
    const j = Number(BigInt(`0x${digest.slice(0, 12)}`) % BigInt(i + 1));
    const a = slots[i]!;
    const b = slots[j]!;
    slots[i] = b;
    slots[j] = a;
  }

  return slots;
}

/**
 * Build a balanced round-robin schedule.
 *
 * @param weeks how many weeks to fill; may exceed one full rotation
 */
export function generateSchedule(
  teamIds: readonly string[],
  weeks: number,
  seed: string,
): readonly ScheduledMatchup[] {
  if (teamIds.length < 2) {
    throw new ScheduleError(`A schedule needs at least 2 teams, got ${teamIds.length}`);
  }
  if (weeks < 1) throw new ScheduleError(`weeks must be at least 1, got ${weeks}`);
  if (new Set(teamIds).size !== teamIds.length) {
    throw new ScheduleError("Team IDs must be unique");
  }

  const rotation = seededRotation(teamIds, seed);
  const size = rotation.length;
  const half = size / 2;

  // Pass 1: who plays whom. The circle method decides pairings only — home and
  // away are assigned afterwards.
  const pairings: { week: number; a: string; b: string | null }[] = [];

  for (let week = 1; week <= weeks; week++) {
    for (let pair = 0; pair < half; pair++) {
      const first = rotation[pair]!;
      const second = rotation[size - 1 - pair]!;

      if (first === BYE) pairings.push({ week, a: second as string, b: null });
      else if (second === BYE) pairings.push({ week, a: first as string, b: null });
      else pairings.push({ week, a: first as string, b: second as string });
    }

    // Circle method: hold the first slot, rotate the remainder clockwise.
    const held = rotation[0]!;
    const rest = rotation.slice(1);
    rest.unshift(rest.pop()!);
    rotation.splice(0, size, held, ...rest);
  }

  // Pass 2: home and away, balanced.
  //
  // Deriving this from the rotation geometry does not work. Only the held team
  // occupies a fixed pair index; everyone else moves through the indices
  // unevenly, so alternating on the index gave one team eleven home games out
  // of fourteen. Instead, hand each game to whoever is furthest behind on home
  // games. Ties break on team ID, so the result never depends on the order
  // pairings were generated in.
  const differential = new Map(teamIds.map((teamId) => [teamId, 0]));

  return pairings.map(({ week, a, b }) => {
    if (b === null) return { week, homeTeamId: a, awayTeamId: null };

    const aIsHome = differential.get(a)! !== differential.get(b)!
      ? differential.get(a)! < differential.get(b)!
      : a < b;
    const home = aIsHome ? a : b;
    const away = aIsHome ? b : a;

    differential.set(home, differential.get(home)! + 1);
    differential.set(away, differential.get(away)! - 1);

    return { week, homeTeamId: home, awayTeamId: away };
  });
}

/** Every matchup for a week. */
export function matchupsForWeek(
  schedule: readonly ScheduledMatchup[],
  week: number,
): readonly ScheduledMatchup[] {
  return schedule.filter((matchup) => matchup.week === week);
}

/** A team's opponent in a week, or `null` on a bye. */
export function opponentOf(
  schedule: readonly ScheduledMatchup[],
  teamId: string,
  week: number,
): string | null {
  for (const matchup of matchupsForWeek(schedule, week)) {
    if (matchup.homeTeamId === teamId) return matchup.awayTeamId;
    if (matchup.awayTeamId === teamId) return matchup.homeTeamId;
  }
  return null;
}

/** How many times each pair of teams meets. */
export function meetingCounts(
  schedule: readonly ScheduledMatchup[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const matchup of schedule) {
    if (!matchup.awayTeamId) continue;
    const key = [matchup.homeTeamId, matchup.awayTeamId].sort().join("|");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

/**
 * Whether every team plays exactly once a week.
 *
 * The property most worth checking: a schedule that double-booked a team, or
 * left one out, would produce a season nobody could reconcile.
 */
export function everyTeamPlaysOncePerWeek(
  schedule: readonly ScheduledMatchup[],
  teamIds: readonly string[],
  weeks: number,
): boolean {
  for (let week = 1; week <= weeks; week++) {
    const appearances = new Map<string, number>();

    for (const matchup of matchupsForWeek(schedule, week)) {
      for (const teamId of [matchup.homeTeamId, matchup.awayTeamId]) {
        if (teamId) appearances.set(teamId, (appearances.get(teamId) ?? 0) + 1);
      }
    }

    for (const teamId of teamIds) {
      if (appearances.get(teamId) !== 1) return false;
    }
  }

  return true;
}

/** Whether byes are spread evenly — no team sits out more than one extra time. */
export function byeCountsAreBalanced(
  schedule: readonly ScheduledMatchup[],
  teamIds: readonly string[],
): boolean {
  const byes = new Map(teamIds.map((teamId) => [teamId, 0]));

  for (const matchup of schedule) {
    if (matchup.awayTeamId === null) {
      byes.set(matchup.homeTeamId, (byes.get(matchup.homeTeamId) ?? 0) + 1);
    }
  }

  const counts = [...byes.values()];
  return Math.max(...counts) - Math.min(...counts) <= 1;
}
