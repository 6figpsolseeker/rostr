/**
 * Rule set validation.
 *
 * Runs once, before a league is created and its rules are frozen. After that
 * point nothing can be corrected, so every invariant that would otherwise be
 * enforced by a commissioner's judgement has to be enforced here instead.
 *
 * Returns all problems rather than throwing on the first, so a league creator
 * sees everything wrong at once.
 */

import type { SportDef } from "../sports/types.js";
import { slotTypesByKey, statKeysByKey } from "../sports/types.js";
import {
  BASIS_POINTS_TOTAL,
  MAX_BUY_IN_BASE_UNITS,
  MAX_FEE_BPS,
  MILLI_POINTS_PER_POINT,
  MIN_BUY_IN_BASE_UNITS,
} from "./types.js";
import type { LeagueRules, ScoringRule } from "./types.js";

const FAST_PICK_SECONDS = [90, 120, 300, 600];
const SLOW_PICK_SECONDS = [3600, 14_400, 28_800, 86_400];

/** The NFL issues official stat corrections for up to seven days. */
const MIN_PAYING_FINALIZATION_HOURS = 168;

/**
 * How long after the last prize could possibly be settled the timelock refund
 * must stay shut.
 *
 * `refund_stake` is unconditional after `refundUnlockAt` — by design, because it
 * is the escape hatch for every failure the program cannot anticipate, and every
 * condition added to it is a new way for money to become permanently stuck. That
 * makes the *date* the only thing standing between the pot and a member who has
 * lost. Set it before the season ends and a losing manager withdraws in week 6
 * and plays on with nothing at risk: refunding decrements `total_deposited` but
 * does not touch `member_count` or the membership, so they keep their roster,
 * their standings place, and their claim on the pot.
 *
 * ## Why sixty days rather than a fortnight
 *
 * The floor below is computed from the draft, because that is the only real
 * timestamp the rules carry — and **the rules do not record the gap between the
 * draft and the first game**. For 2026 that gap is eighteen days (draft Aug 22,
 * kickoff Sep 9), so the estimate lands about a fortnight *early*. This buffer
 * absorbs that as well as leaving the payout room to run.
 *
 * The two ways of being wrong are not symmetric, which is what decides the size:
 *
 * - **Too late** — in the rare case settlement is broken, members wait longer
 *   for money they will certainly get back. An inconvenience.
 * - **Too early** — the escape hatch opens while the pot is still owed to the
 *   winners, and whoever transacts first takes it. Unrecoverable, in a program
 *   with no authority field and no way to claw anything back.
 *
 * One is annoying and one is theft, so an uncertain estimate rounds toward the
 * annoying side.
 *
 * A commissioner may always choose a **later** date; this is a floor.
 */
const MIN_REFUND_GRACE_SECONDS = 60 * 24 * 60 * 60;

function validateScoring(rules: LeagueRules, sport: SportDef, out: string[]): void {
  const known = statKeysByKey(sport);
  const seen = new Set<string>();

  for (const rule of rules.scoring) {
    const def = known.get(rule.statKey);

    if (!def) {
      out.push(`scoring references unknown stat key "${rule.statKey}"`);
      continue;
    }
    if (seen.has(rule.statKey)) {
      out.push(`scoring defines "${rule.statKey}" more than once`);
    }
    seen.add(rule.statKey);

    if (def.kind !== rule.kind) {
      out.push(
        `scoring rule for "${rule.statKey}" is ${rule.kind}, but the sport defines it as ${def.kind}`,
      );
      continue;
    }

    if (rule.kind === "TIERED") {
      validateTiers(rule, out);
    } else if (!Number.isSafeInteger(rule.milliPointsPerUnit)) {
      // Milli-points are the smallest unit there is: 0.04 points per passing
      // yard is 40, not 0.04. A fractional multiplier is the float this whole
      // representation exists to keep out, and `canonicalize` refuses to encode
      // one — so without this check league creation fails at the encoder, after
      // validation has already said the rules are fine.
      out.push(
        `scoring rule "${rule.statKey}" awards ${rule.milliPointsPerUnit} milli-points ` +
          `per unit, which is not a whole number — scoring is integer milli-points ` +
          `(1 point = ${String(MILLI_POINTS_PER_POINT)})`,
      );
    }
  }
}

function validateTiers(rule: Extract<ScoringRule, { kind: "TIERED" }>, out: string[]): void {
  const { statKey, tiers } = rule;
  const before = out.length;

  if (tiers.length === 0) {
    out.push(`tiered rule "${statKey}" has no tiers`);
    return;
  }

  // Every number in a tier is frozen into the canonical document, which admits
  // safe integers only. Swept before the structural checks below because those
  // return on their first finding, and a fractional bound would usually surface
  // there as a confusing "gap or overlap" instead of as itself.
  for (const [i, tier] of tiers.entries()) {
    for (const [field, value] of [
      ["min", tier.min],
      ["max", tier.max],
      ["milliPoints", tier.milliPoints],
    ] as const) {
      if (value !== null && !Number.isSafeInteger(value)) {
        out.push(`tiered rule "${statKey}" tier ${i} has a non-integer ${field}: ${value}`);
      }
    }
  }

  // Stop here if a bound is not a number we can reason about. Everything below
  // does arithmetic on these — the floor comparison and the contiguity walk —
  // and arithmetic on a garbage bound produces a confidently wrong instruction:
  // a fractional max of 6.5 otherwise also reports "expected min 7.5, got 7",
  // telling the creator to start a tier at 7.5, which is itself illegal.
  if (out.length > before) return;

  // The ladder has to cover what the feed can actually emit, and the engine
  // throws — deliberately — on a value no tier covers. The floor is the half
  // nothing else checks: the loop below seeds itself from `tiers[0].min`, so a
  // ladder starting anywhere at all is contiguous with itself and hashes
  // cleanly, and the first uncovered reading then kills scoring for the whole
  // league-week, every cron pass, uncorrectably, because rules are frozen.
  //
  // Zero is the one value we can assert without knowing the stat: it is what
  // "nothing happened" reads as, and a provider emits it as a fact rather than
  // as an absence. **This says nothing about negatives.** A ladder over a stat
  // whose feed can go below zero is still able to fall off its own bottom, and
  // no check here can see that — `StatKeyDef` carries no domain. See the note in
  // `applyTiered`.
  //
  // It also refuses a ladder over a stat whose feed reports "none" as an
  // absence rather than a zero — longest-field-goal, say, which would naturally
  // start at 20. That is a false positive, and it is the accepted cost: it is
  // visible at creation and fixed by prepending one tier, while the case it
  // catches is invisible until the first shutout and then uncorrectable.
  //
  // Taken from the lowest bound anywhere in the ladder rather than `tiers[0]`'s.
  // On an out-of-order ladder those differ, and blaming `tiers[0]` would say "a
  // value of 0 falls below every tier" about a ladder where a later tier covers
  // it — true verdict, false reason. The ordering check below rejects it either
  // way; this just declines to be wrong on the way there.
  const floor = Math.min(...tiers.map((tier) => tier.min));
  if (floor > 0) {
    out.push(
      `tiered rule "${statKey}" starts at ${floor}, so a value of 0 falls below every ` +
        `tier and scoring throws rather than scoring it`,
    );
  }

  let expectedMin: number | null = tiers[0]?.min ?? 0;

  for (const [i, tier] of tiers.entries()) {
    const last = i === tiers.length - 1;

    if (expectedMin === null) {
      out.push(`tiered rule "${statKey}" continues past an unbounded tier at index ${i}`);
      return;
    }
    if (tier.min !== expectedMin) {
      out.push(
        `tiered rule "${statKey}" has a gap or overlap at index ${i}: ` +
          `expected min ${expectedMin}, got ${tier.min}`,
      );
      return;
    }
    if (tier.max !== null && tier.max < tier.min) {
      out.push(`tiered rule "${statKey}" tier ${i} has max below min`);
      return;
    }
    if (tier.max === null && !last) {
      out.push(`tiered rule "${statKey}" has an unbounded tier before the end`);
      return;
    }
    if (last && tier.max !== null) {
      out.push(
        `tiered rule "${statKey}" must end with an unbounded tier, ` +
          `or a value above ${tier.max} would score nothing`,
      );
      return;
    }

    expectedMin = tier.max === null ? null : tier.max + 1;
  }
}

function validateRoster(rules: LeagueRules, sport: SportDef, out: string[]): void {
  const slots = slotTypesByKey(sport);

  if (rules.roster.starters.length === 0) out.push("roster defines no starting slots");

  for (const slot of rules.roster.starters) {
    if (!slots.has(slot.slotType)) {
      out.push(`roster references unknown slot type "${slot.slotType}"`);
    }
    if (slot.count <= 0) {
      out.push(`roster slot "${slot.slotType}" must have a positive count`);
    }
  }

  if (rules.roster.benchSlots < 0) out.push("benchSlots cannot be negative");
  if (rules.roster.irSlots < 0) out.push("irSlots cannot be negative");

  // Checked even though the type already narrows it: rules arrive as JSON from
  // a request and from the database, where a string is a string.
  if (
    rules.roster.autofill !== "WEEKLY_PROJECTION" &&
    rules.roster.autofill !== "SEASON_AVERAGE"
  ) {
    out.push(`roster autofill "${String(rules.roster.autofill)}" is not a known mode`);
  }
}

function validateDraft(rules: LeagueRules, out: string[]): void {
  const { mode, pickSeconds } = rules.draft;
  const allowed = mode === "FAST" ? FAST_PICK_SECONDS : SLOW_PICK_SECONDS;

  if (!allowed.includes(pickSeconds)) {
    out.push(
      `draft pickSeconds ${pickSeconds} is not permitted for ${mode} mode ` +
        `(allowed: ${allowed.join(", ")})`,
    );
  }
  if (pickSeconds < 90) out.push("draft pick clock may never be below 90 seconds");
  if (rules.draft.scheduledAt <= 0) out.push("draft scheduledAt must be set at creation");
}

function validateSchedule(rules: LeagueRules, out: string[]): void {
  const s = rules.schedule;

  if (s.regularSeasonWeeks <= 0) out.push("regularSeasonWeeks must be positive");
  if (s.playoffTeams > rules.league.maxTeams) {
    out.push(`playoffTeams (${s.playoffTeams}) exceeds maxTeams (${rules.league.maxTeams})`);
  }
  if (s.playoffTeams < 2) out.push("playoffTeams must be at least 2");
  if (s.byeSeeds >= s.playoffTeams) out.push("byeSeeds must be fewer than playoffTeams");
  if (s.byeSeeds < 0) out.push("byeSeeds cannot be negative");

  // The bracket has to actually resolve: after the first round, the survivors
  // plus the bye teams must be a power of two.
  const firstRoundTeams = s.playoffTeams - s.byeSeeds;
  if (firstRoundTeams % 2 !== 0) {
    out.push(
      `bracket does not resolve: ${firstRoundTeams} teams in the first round cannot pair up`,
    );
  } else {
    const afterFirstRound = firstRoundTeams / 2 + s.byeSeeds;
    if (afterFirstRound > 0 && (afterFirstRound & (afterFirstRound - 1)) !== 0) {
      out.push(
        `bracket does not resolve: ${afterFirstRound} teams after round 1 is not a power of two`,
      );
    } else {
      const rounds = Math.log2(afterFirstRound) + (firstRoundTeams > 0 ? 1 : 0);
      if (s.playoffWeeks.length !== rounds) {
        out.push(
          `bracket needs ${rounds} rounds but ${s.playoffWeeks.length} playoff weeks are defined`,
        );
      }
    }
  }

  for (const [i, week] of s.playoffWeeks.entries()) {
    if (week <= s.regularSeasonWeeks) {
      out.push(`playoff week ${week} overlaps the regular season`);
    }
    const prev = s.playoffWeeks[i - 1];
    if (prev !== undefined && week <= prev) out.push("playoffWeeks must ascend");
  }

  if (s.tiebreakers.length === 0) {
    out.push("at least one tiebreaker is required");
  } else if (s.tiebreakers.at(-1) !== "LOWEST_TEAM_ID") {
    out.push(
      "the final tiebreaker must be LOWEST_TEAM_ID — seeding must resolve deterministically",
    );
  }
}

function validateWaivers(rules: LeagueRules, out: string[]): void {
  const w = rules.waivers;

  if (w.waiverPeriodDays <= 0) out.push("waiverPeriodDays must be positive");
  if (w.shortTenureHours < 0) out.push("shortTenureHours cannot be negative");

  // A timezone, never an offset — the season crosses the daylight-saving change.
  if (!w.timezone) {
    out.push("waivers require a timezone, e.g. America/New_York");
  } else {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: w.timezone });
    } catch {
      out.push(`waiver timezone "${w.timezone}" is not a valid IANA timezone`);
    }
  }

  for (const [label, moment] of [
    ["weeklyLock", w.weeklyLock],
    ["processing", w.processing],
  ] as const) {
    if (!Number.isInteger(moment.hour) || moment.hour < 0 || moment.hour > 23) {
      out.push(`${label}.hour must be an integer 0-23, got ${moment.hour}`);
    }
  }

  if (w.weeklyLock.day === w.processing.day && w.weeklyLock.hour === w.processing.hour) {
    out.push("the weekly lock and processing run cannot be the same moment");
  }
}

function validateTrades(rules: LeagueRules, out: string[]): void {
  const t = rules.trades;
  if (!t.enabled) return;

  if (t.vetoDenominator <= 0) out.push("vetoDenominator must be positive");
  if (t.vetoNumerator <= 0) out.push("vetoNumerator must be positive");
  if (t.vetoNumerator > t.vetoDenominator) out.push("veto threshold exceeds 100%");
  if (t.vetoWindowHours <= 0) out.push("vetoWindowHours must be positive");

  // The deadline is the commissioner's to set, so it needs a floor as well as a
  // ceiling. Week 0 would leave trading enabled in the rules and impossible in
  // practice — members would sign a rule set that says one thing and behaves
  // like another, and rules cannot be corrected afterwards.
  if (t.deadlineWeek < 1) {
    out.push("trade deadline must be at least week 1, or disable trades outright");
  }
  if (t.deadlineWeek > rules.schedule.regularSeasonWeeks) {
    out.push(
      `trade deadline (week ${t.deadlineWeek}) falls after the regular season ends ` +
        `(week ${rules.schedule.regularSeasonWeeks})`,
    );
  }
}

/**
 * The earliest instant a league's timelock refund may open.
 *
 * Every term comes from the frozen rules, so this needs no calendar, no provider
 * and no new field — which matters, because adding a field would move the golden
 * hash and break the `rules_hash` of every league already anchored.
 *
 * ```
 *   draft.scheduledAt
 * + (regularSeasonWeeks + playoffWeeks.length) weeks
 * + payingFinalizationHours          the correction window on the last prize
 * + MIN_REFUND_GRACE_SECONDS
 * ```
 *
 * **It is an approximation, and knowingly a conservative one.** The rules do not
 * record when the season starts, only when the draft is, so the weeks are
 * counted from a point some way before kickoff and the estimate lands early. See
 * `MIN_REFUND_GRACE_SECONDS` for why the buffer is sized to swallow that.
 *
 * The last playoff week is used rather than `regularSeasonWeeks + playoffWeeks
 * .length` being assumed contiguous — a league may define playoff weeks that do
 * not immediately follow the regular season, and counting the array's length
 * would then finish early.
 */
export function earliestRefundUnlock(input: {
  readonly draftScheduledAt: number;
  readonly regularSeasonWeeks: number;
  readonly playoffWeeks: readonly number[];
  readonly payingFinalizationHours: number;
}): number {
  // `Math.max` over both, because either could be the later one: a league with
  // no playoff weeks at all finishes at the end of its regular season.
  const lastWeek = Math.max(input.regularSeasonWeeks, ...input.playoffWeeks, 0);

  return (
    input.draftScheduledAt +
    lastWeek * 7 * 24 * 60 * 60 +
    input.payingFinalizationHours * 60 * 60 +
    MIN_REFUND_GRACE_SECONDS
  );
}

function refundUnlockFloor(rules: LeagueRules): number {
  return earliestRefundUnlock({
    draftScheduledAt: rules.draft.scheduledAt,
    regularSeasonWeeks: rules.schedule.regularSeasonWeeks,
    playoffWeeks: rules.schedule.playoffWeeks,
    payingFinalizationHours: rules.settlement.payingFinalizationHours,
  });
}

function validateRefundUnlock(rules: LeagueRules, refundUnlockAt: number, out: string[]): void {
  const floor = refundUnlockFloor(rules);
  if (refundUnlockAt >= floor) return;

  const short = Math.ceil((floor - refundUnlockAt) / (24 * 60 * 60));

  out.push(
    `pot.refundUnlockAt is ${short} day${short === 1 ? "" : "s"} too early: the timelock ` +
      `refund is unconditional once it opens, so a date before the last prize has settled ` +
      `lets a losing member withdraw and keep playing for a pot they no longer stand behind. ` +
      `The earliest permitted value is ${floor}.`,
  );
}

function validatePot(rules: LeagueRules, out: string[]): void {
  const pot = rules.pot;
  if (pot === null) return;

  if (!/^[1-9][0-9]*$/.test(pot.buyInBaseUnits)) {
    out.push("buyInBaseUnits must be a positive integer expressed as a decimal string");
  } else {
    // BigInt because a u64 buy-in can exceed Number.MAX_SAFE_INTEGER, and a
    // comparison that silently rounds is exactly the class of bug the
    // decimal-string representation exists to avoid.
    const units = BigInt(pot.buyInBaseUnits);
    if (units < BigInt(MIN_BUY_IN_BASE_UNITS)) {
      out.push(
        `buy-in is below the ${MIN_BUY_IN_BASE_UNITS} base-unit minimum ` +
          `(a pot smaller than this costs more to move than it pays out)`,
      );
    }
    if (units > BigInt(MAX_BUY_IN_BASE_UNITS)) {
      out.push(
        `buy-in is above the ${MAX_BUY_IN_BASE_UNITS} base-unit cap ` +
          `while the escrow is unaudited`,
      );
    }
  }
  if (pot.tokenMint.length === 0) out.push("pot requires a token mint");
  if (pot.refundUnlockAt <= 0) {
    out.push("pot requires a refund unlock time");
  } else {
    validateRefundUnlock(rules, pot.refundUnlockAt, out);
  }

  // A fee is permitted to be zero — a league that pays us nothing is a valid
  // league — but never negative, never fractional, and never unbounded.
  if (!Number.isInteger(pot.feeBps) || pot.feeBps < 0) {
    out.push("pot fee must be a non-negative whole number of basis points");
  } else if (pot.feeBps > MAX_FEE_BPS) {
    out.push(`pot fee is ${pot.feeBps} basis points, above the ${MAX_FEE_BPS} ceiling`);
  }
  if (pot.feeBps > 0 && pot.feeRecipient.length === 0) {
    out.push("a pot fee requires a recipient");
  }

  if (pot.payout.length === 0) {
    out.push("pot defines no payout shares");
    return;
  }

  const total = pot.payout.reduce((sum, share) => sum + share.basisPoints, 0);
  if (total !== BASIS_POINTS_TOTAL) {
    out.push(
      `payout shares sum to ${total} basis points, must be exactly ${BASIS_POINTS_TOTAL}`,
    );
  }

  const seen = new Set<string>();
  for (const share of pot.payout) {
    if (seen.has(share.prize)) out.push(`payout defines ${share.prize} more than once`);
    seen.add(share.prize);
    if (share.basisPoints <= 0) out.push(`payout share ${share.prize} must be positive`);
  }

  const champion = pot.payout.find((s) => s.prize === "CHAMPION");
  if (!champion) {
    out.push("payout must include a CHAMPION share");
  } else {
    // **Strictly** largest, matching the escrow program. A tie passed here and
    // then failed on-chain with ChampionNotLargest — after the rules were frozen,
    // so the league could never be anchored and never be corrected.
    const others = pot.payout.filter((s) => s.prize !== "CHAMPION");
    if (others.some((s) => s.basisPoints >= champion.basisPoints)) {
      out.push("CHAMPION must hold the largest single payout share, strictly");
    }
  }

  if (rules.schedule.consolationBracket === false) {
    if (pot.payout.some((s) => s.prize === "CONSOLATION")) {
      out.push("payout includes a CONSOLATION share but no consolation bracket is scheduled");
    }
  }
}

function validateSettlement(rules: LeagueRules, out: string[]): void {
  const s = rules.settlement;

  if (s.requiredOracleSources < 1) out.push("at least one oracle source is required");
  if (rules.pot !== null && s.requiredOracleSources < 2) {
    out.push("a league with a pot requires at least two independent oracle sources");
  }
  if (s.standardFinalizationHours <= 0) out.push("standardFinalizationHours must be positive");
  if (s.payingFinalizationHours < MIN_PAYING_FINALIZATION_HOURS) {
    out.push(
      `payingFinalizationHours must be at least ${MIN_PAYING_FINALIZATION_HOURS} ` +
        `— official stat corrections arrive for up to seven days after a game`,
    );
  }
  if (s.payingFinalizationHours < s.standardFinalizationHours) {
    out.push("paying weeks cannot finalise sooner than standard weeks");
  }

  const lastPlayoffWeek = rules.schedule.playoffWeeks.at(-1);
  if (lastPlayoffWeek !== undefined && !s.payingWeeks.includes(lastPlayoffWeek)) {
    out.push(`the championship week (${lastPlayoffWeek}) must be a paying week`);
  }
}

function validateLeagueSize(rules: LeagueRules, out: string[]): void {
  const l = rules.league;
  if (l.minHumans < 2) out.push("a league requires at least 2 humans");
  if (l.maxTeams < l.minHumans) out.push("maxTeams cannot be below minHumans");
  if (l.maxTeams < 2) out.push("maxTeams must be at least 2");

  if (!Number.isSafeInteger(l.maxBots) || l.maxBots < 0) {
    out.push("maxBots must be a non-negative whole number");
  }

  // A bot has no wallet and pays no buy-in, so a bot finishing in a paying
  // position would leave that share with no recipient — on-chain, where there is
  // nobody to appeal to. Barred outright rather than handled.
  if (rules.pot !== null && l.maxBots > 0) {
    out.push("a league with a pot cannot allow bots — a bot cannot be paid");
  }

  // A bot exists to square an odd number of friends. More than one is a
  // different product, and one nobody asked for.
  if (l.maxBots > 1) out.push("at most one bot per league");

  if (l.maxBots > 0 && l.maxTeams - l.maxBots < l.minHumans) {
    out.push("maxBots would leave room for fewer than minHumans");
  }
}

/**
 * Every numeric field a request can set, checked as a whole number.
 *
 * These four arrive from the creation route's body and reach the encoder with
 * no other check. `canonicalize` refuses a non-integer, so a fractional one
 * cannot be frozen — but it surfaces as an encoder error naming a JSON path
 * rather than as a problem the creator can read, and the empty-array contract
 * above would have been a lie for that rule set.
 *
 * **The `typeof` half is the one that matters.** The encoder checks that a
 * *number* is a safe integer; it does not check that a number is a number. A
 * `seasonYear` of `"2026"` — or of `[1, 2]` — validated clean and hashed
 * clean, freezing a league permanently around a value of the wrong type. Rules
 * are immutable, so there is no correcting that afterwards.
 */
function validateNumericFields(rules: LeagueRules, out: string[]): void {
  const fields: readonly (readonly [string, unknown])[] = [
    ["seasonYear", rules.seasonYear],
    ["draft.scheduledAt", rules.draft.scheduledAt],
    ["trades.deadlineWeek", rules.trades.deadlineWeek],
    ...(rules.pot ? ([["pot.refundUnlockAt", rules.pot.refundUnlockAt]] as const) : []),
  ];

  for (const [name, value] of fields) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      out.push(`${name} must be a whole number, got ${JSON.stringify(value)}`);
    }
  }
}

/**
 * Validate a rule set against its sport.
 *
 * @returns every problem found. An empty array means **nothing checked here is
 * wrong** — which is not the same as "safe to freeze", and the difference has
 * bitten already. `canonicalize` remains the final authority on what can be
 * encoded: it rejects any non-integer, and `createLeague` encodes before it
 * opens its transaction, so a rule set that gets past here and fails there
 * still cannot reach storage. It surfaces as a `CanonicalEncodingError`, which
 * the creation route catches.
 */
export function validateLeagueRules(rules: LeagueRules, sport: SportDef): string[] {
  const out: string[] = [];

  if (rules.sportKey !== sport.key) {
    out.push(
      `rules declare sport "${rules.sportKey}" but were validated against "${sport.key}"`,
    );
    return out;
  }

  validateNumericFields(rules, out);
  validateScoring(rules, sport, out);
  validateRoster(rules, sport, out);
  validateLeagueSize(rules, out);
  validateDraft(rules, out);
  validateSchedule(rules, out);
  validateWaivers(rules, out);
  validateTrades(rules, out);
  validatePot(rules, out);
  validateSettlement(rules, out);

  return out;
}
