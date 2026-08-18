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

import bs58 from "bs58";
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
 * The most teams a league may have. `docs/RULES.md` §3.
 *
 * Exported because the escrow program mirrors it and the two must not drift —
 * the program's bound is what binds callers who never touch this service, and
 * this one is what gives a creator the error before their rules are frozen.
 *
 * **It is a settlement bound, not a scheduling one.** The round robin handles
 * any size; the on-chain derivation kernels do not, because their fixed arrays
 * are sized to a constant and `compute_records` refuses above it. A league over
 * this cap plays a full season and then cannot be settled at all.
 */
export const MAX_TEAMS_PER_LEAGUE = 12;

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

/**
 * How much later than the floor a commissioner may set the refund, ordinarily.
 *
 * The floor already sits sixty days past a deliberately conservative settlement
 * estimate, so this is discretion on top of slack. Ninety days covers a
 * commissioner who wants room and refuses nothing a real league would pick — for
 * the default NFL schedule the legal window is ninety days wide.
 *
 * **The asymmetry that sized the floor runs the other way here**, which is why
 * this can be tight where `MIN_REFUND_GRACE_SECONDS` had to be generous. Too
 * early is theft; too late is a freeze. But a ceiling set too *tight* costs only
 * a 400 at creation, before anything is frozen and before any money exists — the
 * creator picks another date. Nothing on this side is unrecoverable, so the
 * estimate rounds toward the strict end rather than the loose one.
 */
const MAX_REFUND_DISCRETION_SECONDS = 90 * 24 * 60 * 60;

/**
 * The furthest past its own draft a league's refund may ever open.
 *
 * This is the bound that cannot be inflated — see `latestRefundUnlock` for why
 * the floor-relative one can be. A year past the draft, the season is long
 * finished and the next season's leagues are forming; anything still locked then
 * is visibly wrong.
 *
 * The unsatisfiable case — a schedule so long that the floor passes this — fires
 * at a last week of 43 or beyond, against a real NFL calendar that tops out at
 * 22. There is no schedule between "real" and "refused"; the gap is twenty-one
 * weeks wide.
 */
const MAX_REFUND_HORIZON_SECONDS = 365 * 24 * 60 * 60;

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
/**
 * The shortest gap between creating a league and its draft.
 *
 * An hour. Enough to send the link round; short enough not to constrain anyone
 * who genuinely wants to draft this afternoon.
 */
export const MIN_DRAFT_LEAD_SECONDS = 3600;

/**
 * Why this draft time cannot be used, or `null` if it can.
 *
 * **Separate from `validateLeagueRules`, and it has to be.** That function is
 * pure in the strong sense — same rules, same answer, forever — which is what
 * lets it be re-run against a frozen document years later to check the league was
 * legal when it was made. A rule that consults the clock cannot live there: every
 * league in the repository would start failing its own validation the day after
 * it drafted, and the golden fixture's `scheduledAt` is in 2025.
 *
 * So the clock is the caller's, passed explicitly, and this is called at the one
 * moment it makes sense — creation. The same shape as `earliestRefundUnlock`, and
 * for the same reason: the form and the route share one definition, so the form
 * cannot suggest a date the server refuses.
 *
 * **Why it matters now.** The draft time is when the field locks: the order's
 * seed is the first Solana block at or after it, so anyone can compute the seed
 * from that instant and a field that could still change afterwards is grindable.
 * A league created with a draft time already past would therefore refuse its
 * own first join — including the commissioner's — and rules are immutable, so it
 * could never be corrected, only recreated under a new id. That was reachable by
 * accepting the create form's default from 22 August 2026 onward.
 */
export function draftDateProblem(scheduledAt: number, now: Date): string | null {
  if (!Number.isFinite(scheduledAt) || scheduledAt <= 0) {
    return "draft scheduledAt must be set at creation";
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (scheduledAt <= nowSeconds) {
    return "the draft time has already passed — a league cannot be created to draft in the past";
  }
  if (scheduledAt - nowSeconds < MIN_DRAFT_LEAD_SECONDS) {
    return "the draft must be at least an hour away, so there is time for anyone to join";
  }

  return null;
}

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

/**
 * The latest instant a league's timelock refund may open.
 *
 * **Two bounds, and the smaller wins.** They do different jobs:
 *
 * - `floor + MAX_REFUND_DISCRETION_SECONDS` is the ordinary one. Ninety days of
 *   discretion above a floor that already carries sixty days of grace past
 *   settlement is more than any honest commissioner needs.
 * - `draft.scheduledAt + MAX_REFUND_HORIZON_SECONDS` is what makes the first one
 *   mean anything. **The floor is derived from attacker-writable inputs that
 *   nothing bounds above** — `validateSchedule` bounds week numbers only by
 *   `> 0` and ascending, and `validateSettlement` bounds
 *   `payingFinalizationHours` only from below. So `playoffWeeks: [15, 16, 900]`
 *   validates today and drags a floor-relative ceiling to 2043;
 *   `payingFinalizationHours: 200_000` drags it to 2048 with an ordinary
 *   seventeen-week schedule. A ceiling built only on the floor stretches to fit
 *   whatever the commissioner invents, which moves the hole rather than closing
 *   it.
 *
 * `draft.scheduledAt` is the one term in the floor's formula the other levers
 * cannot inflate, which is why the cap hangs off it. It is also the right clock
 * on its own terms: the floor answers "has the money been distributed yet",
 * necessarily schedule-relative, while the ceiling answers "how long may a
 * member's capital be trapped" — and that starts when the money goes in, around
 * the draft, not at settlement.
 *
 * Read it and you can see the maximum lock-up without reading any other
 * function. That locality is the property a floor-relative ceiling gives up.
 */
export function latestRefundUnlock(input: {
  readonly draftScheduledAt: number;
  readonly regularSeasonWeeks: number;
  readonly playoffWeeks: readonly number[];
  readonly payingFinalizationHours: number;
}): number {
  return Math.min(
    earliestRefundUnlock(input) + MAX_REFUND_DISCRETION_SECONDS,
    input.draftScheduledAt + MAX_REFUND_HORIZON_SECONDS,
  );
}

function refundUnlockCeiling(rules: LeagueRules): number {
  return latestRefundUnlock({
    draftScheduledAt: rules.draft.scheduledAt,
    regularSeasonWeeks: rules.schedule.regularSeasonWeeks,
    playoffWeeks: rules.schedule.playoffWeeks,
    payingFinalizationHours: rules.settlement.payingFinalizationHours,
  });
}

function validateRefundUnlock(rules: LeagueRules, refundUnlockAt: number, out: string[]): void {
  const floor = refundUnlockFloor(rules);
  const ceiling = refundUnlockCeiling(rules);

  // `pot.refundUnlockAt <= 0` is *false* for a string — `"abc" <= 0` is `false`
  // — so a non-number reaches here, and `earliestRefundUnlock` then concatenates
  // rather than adds: a string `scheduledAt` yields a "floor" of 1.7e30. One
  // garbage comparison was survivable; two that can disagree with each other are
  // not. `validateNumericFields` has already reported the real problem, so
  // returning silently loses nothing.
  if (
    typeof refundUnlockAt !== "number" ||
    !Number.isFinite(floor) ||
    !Number.isFinite(ceiling)
  ) {
    return;
  }

  const days = (seconds: number): number => Math.ceil(seconds / (24 * 60 * 60));

  // Checked first, and returns, so the "too early" message below can never name
  // a floor that is itself illegal. Reachable because nothing caps week numbers
  // or `payingFinalizationHours` — a schedule long enough closes the window
  // entirely, and the honest answer is that the schedule is the problem rather
  // than the date.
  if (floor > ceiling) {
    out.push(
      `this league's schedule settles ${days(floor - ceiling)} days beyond the latest ` +
        `permitted refund unlock (${ceiling}), so no legal value exists — shorten the ` +
        `regular season, the playoff weeks, or payingFinalizationHours`,
    );
    return;
  }

  if (refundUnlockAt < floor) {
    const short = days(floor - refundUnlockAt);
    out.push(
      `pot.refundUnlockAt is ${short} day${short === 1 ? "" : "s"} too early: the timelock ` +
        `refund is unconditional once it opens, so a date before the last prize has settled ` +
        `lets a losing member withdraw and keep playing for a pot they no longer stand behind. ` +
        `The earliest permitted value is ${floor}.`,
    );
    return;
  }

  if (refundUnlockAt > ceiling) {
    const over = days(refundUnlockAt - ceiling);
    out.push(
      `pot.refundUnlockAt is ${over} day${over === 1 ? "" : "s"} too late: the timelock ` +
        `refund is the only way tokens leave the vault — there is no settlement instruction ` +
        `yet, no setter and no authority — so a date long past the season freezes every ` +
        `member's buy-in with nothing able to release it. ` +
        `The latest permitted value is ${ceiling}.`,
    );
  }
}

/**
 * Whether a string is a well-formed Solana address.
 *
 * Base58 decoding to exactly 32 bytes, which is all a chain-free package can
 * honestly check: it does not prove the account exists, holds a mint, or is the
 * one anybody wanted. It does refuse the failures that are silent and permanent
 * — a truncated paste, a checksum-less typo, an address in the wrong encoding.
 * `bs58.decode` throws on an invalid alphabet rather than returning a flag.
 */
function isPublicKeyLike(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
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
  // Shape only, deliberately. *Which* mint is a per-cluster question and this
  // package is chain-free — it depends on no web3 library and knows nothing
  // about clusters, which is what lets the same encoder produce the same hash
  // everywhere. The server picks the mint from `POT_MINTS`; this checks that
  // whatever ends up in the frozen document is at least a public key, because
  // "is not the empty string" was the entire test and it let a typo, a
  // truncation, or a sentence be hashed into a league's rules for good.
  if (!isPublicKeyLike(pot.tokenMint)) out.push("pot requires a valid token mint address");

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

  /*
    And a ceiling, which there was not one of until 2026-08-17.

    `docs/RULES.md` §3 caps a league at twelve and nothing enforced it, so a
    twenty-team pot league was creatable and anchorable. The cost is not the
    schedule — the round robin handles any size — it is that **settlement could
    never complete**: the on-chain derivation kernels size their fixed arrays to
    `MAX_TEAMS`, and `compute_records` refuses `TooManyTeams` above it. A league
    over the cap would play a full season and then fall to the timelock refund,
    with no earlier signal at all.

    Frozen rules mean this is only ever fixable *before* creation, which is why
    it belongs here and in `initialize_league` rather than at settlement. The
    program carries the same bound so it binds every caller, not only the ones
    who came through this service.
  */
  if (l.maxTeams > MAX_TEAMS_PER_LEAGUE) {
    out.push(`maxTeams cannot exceed ${MAX_TEAMS_PER_LEAGUE}`);
  }

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
