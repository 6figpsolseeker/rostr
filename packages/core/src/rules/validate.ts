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
  DRAFT_TO_KICKOFF_SLACK_SECONDS,
  MAX_FEE_BPS,
  MAX_REFUND_UNLOCK_LEAD_SECONDS,
  MIN_BUY_IN_BASE_UNITS,
} from "./types.js";
import type { LeagueRules, ScoringRule } from "./types.js";

const FAST_PICK_SECONDS = [90, 120, 300, 600];
const SLOW_PICK_SECONDS = [3600, 14_400, 28_800, 86_400];

/** The NFL issues official stat corrections for up to seven days. */
const MIN_PAYING_FINALIZATION_HOURS = 168;

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

    if (rule.kind === "TIERED") validateTiers(rule, out);
  }
}

function validateTiers(rule: Extract<ScoringRule, { kind: "TIERED" }>, out: string[]): void {
  const { statKey, tiers } = rule;

  if (tiers.length === 0) {
    out.push(`tiered rule "${statKey}" has no tiers`);
    return;
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
 * The earliest instant a league can possibly have finished paying out.
 *
 * Everything here comes from the frozen rules, deliberately: validation takes no
 * clock, so a time-dependent bound would make a fixture that passes today fail
 * on some arbitrary future date and turn CI into a time bomb.
 *
 * The slack matters and is easy to leave out. The draft is scheduled *before*
 * week 1 — roughly three weeks before, in the 2026 calendar — so counting the
 * season's weeks from `scheduledAt` lands short of the championship. Without it
 * the floor for a default league falls on 2026-12-26, which is inside week 16,
 * and the bound would license exactly the mid-playoff withdrawal it exists to
 * prevent.
 */
function settlementInstant(rules: LeagueRules): number {
  const lastWeek = Math.max(rules.schedule.regularSeasonWeeks, ...rules.schedule.playoffWeeks);

  return (
    rules.draft.scheduledAt +
    DRAFT_TO_KICKOFF_SLACK_SECONDS +
    lastWeek * 7 * 86_400 +
    rules.settlement.payingFinalizationHours * 3_600
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

  // **The timelock is the escape hatch, so it has to be reachable and it has to
  // be late enough.** `refund_stake` is the only instruction that moves tokens
  // out of the vault, it consults no league state, and the rules are frozen — so
  // both ends of this window are permanent for the league that signs them.
  //
  // Too early and a member withdraws a stake the pot still owes a champion.
  // Too late and "your money is recoverable" is a promise about a date nobody
  // lives to see; the program will happily accept either.
  //
  // Derived from the rule set rather than the clock, so validation stays pure
  // and a fixture cannot rot into failure on an arbitrary future date.
  if (!Number.isSafeInteger(pot.refundUnlockAt) || pot.refundUnlockAt <= 0) {
    // Not merely tidiness. `NaN` compares false against *both* bounds below, so
    // without this guard it walks through the window untouched and only fails
    // later, inside `canonicalize`, as a 500 rather than a validation problem.
    out.push("pot requires a refund unlock time in whole Unix seconds");
  } else {
    const settlesAt = settlementInstant(rules);

    if (pot.refundUnlockAt < settlesAt) {
      out.push(
        `refund unlock (${pot.refundUnlockAt}) falls before this league can settle ` +
          `(${settlesAt}) — a member could withdraw a stake the pot still owes`,
      );
    } else if (pot.refundUnlockAt > settlesAt + MAX_REFUND_UNLOCK_LEAD_SECONDS) {
      out.push(
        `refund unlock (${pot.refundUnlockAt}) is more than ` +
          `${MAX_REFUND_UNLOCK_LEAD_SECONDS / 86_400} days past settlement ` +
          `(${settlesAt}) — the escape hatch has to stay reachable`,
      );
    }
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
 * Validate a rule set against its sport.
 *
 * @returns every problem found; an empty array means the rules are coherent and
 * safe to freeze.
 */
export function validateLeagueRules(rules: LeagueRules, sport: SportDef): string[] {
  const out: string[] = [];

  if (rules.sportKey !== sport.key) {
    out.push(
      `rules declare sport "${rules.sportKey}" but were validated against "${sport.key}"`,
    );
    return out;
  }

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
