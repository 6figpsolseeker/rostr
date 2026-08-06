/**
 * Draft state.
 *
 * A pure state machine: every transition returns a new state, and an illegal
 * pick is rejected rather than recorded. Nothing here touches a clock or a
 * database — timers are computed, not run, so the same logic drives a live room
 * and a slow draft, and tests can play out a full draft instantly.
 */

import type { DraftRules } from "../rules/types.js";
import { autoPick } from "./autopick.js";
import type { AutoPickSource } from "./autopick.js";
import { canDraft, wouldStrandStarters } from "./roster.js";
import type { DraftablePlayer, IllegalPickReason, RosterShape } from "./roster.js";
import { pickPosition, teamOnClock, totalPicks } from "./order.js";

export interface DraftPick {
  /** 1-based, counting through every round. */
  readonly pickNumber: number;
  readonly round: number;
  readonly teamId: string;
  readonly playerId: string;
  /** How the pick was made. `MANUAL` means a human chose it. */
  readonly source: "MANUAL" | AutoPickSource;
}

export interface DraftState {
  /** Team IDs in round-1 order. */
  readonly order: readonly string[];
  readonly rounds: number;
  readonly picks: readonly DraftPick[];
}

export type DraftErrorCode =
  | "DRAFT_COMPLETE"
  | "NOT_ON_CLOCK"
  | "PLAYER_UNAVAILABLE"
  | "NO_LEGAL_PICK"
  | IllegalPickReason;

export class DraftError extends Error {
  constructor(
    message: string,
    readonly code: DraftErrorCode,
  ) {
    super(message);
    this.name = "DraftError";
  }
}

export function createDraft(order: readonly string[], rounds: number): DraftState {
  return { order, rounds, picks: [] };
}

export function isComplete(state: DraftState): boolean {
  return state.picks.length >= totalPicks(state.order.length, state.rounds);
}

/** The pick number currently on the clock. */
export function currentPickNumber(state: DraftState): number {
  return state.picks.length + 1;
}

/** The team on the clock, or `null` if the draft is over. */
export function currentTeam(state: DraftState): string | null {
  if (isComplete(state)) return null;
  return teamOnClock(currentPickNumber(state), state.order);
}

/** Players already taken. */
export function draftedPlayerIds(state: DraftState): ReadonlySet<string> {
  return new Set(state.picks.map((pick) => pick.playerId));
}

/** A team's roster so far, in pick order. */
export function rosterFor(
  state: DraftState,
  teamId: string,
  pool: ReadonlyMap<string, DraftablePlayer>,
): readonly DraftablePlayer[] {
  return state.picks
    .filter((pick) => pick.teamId === teamId)
    .map((pick) => pool.get(pick.playerId))
    .filter((player): player is DraftablePlayer => player !== undefined);
}

/** Picks a team still has after the one currently on the clock. */
export function picksRemainingAfter(state: DraftState, teamId: string): number {
  const total = totalPicks(state.order.length, state.rounds);
  let remaining = 0;

  for (let pick = currentPickNumber(state) + 1; pick <= total; pick++) {
    if (teamOnClock(pick, state.order) === teamId) remaining++;
  }

  return remaining;
}

export interface MakePickInput {
  readonly teamId: string;
  readonly playerId: string;
  readonly pool: ReadonlyMap<string, DraftablePlayer>;
  readonly shape: RosterShape;
}

/**
 * Whether a manual pick would strand the team's starting lineup.
 *
 * Call this *before* `makePick` and show the answer. The pick is permitted
 * either way — a manager who wants nothing but wide receivers may have them —
 * but the consequence has to be visible before they confirm, not discovered in
 * Week 1 when the lineup will not validate.
 */
export function pickWouldStrandStarters(state: DraftState, input: MakePickInput): boolean {
  const player = input.pool.get(input.playerId);
  if (!player) return false;

  return wouldStrandStarters(
    rosterFor(state, input.teamId, input.pool),
    player,
    input.shape,
    picksRemainingAfter(state, input.teamId),
  );
}

/**
 * Record a manual pick.
 *
 * Rejects only what is genuinely impossible: out of turn, player gone, roster
 * full, already rostered.
 *
 * **A bad draft is allowed.** Taking six quarterbacks and no kicker is a
 * decision, not an error, and it is the manager's to make — the same as ESPN and
 * Sleeper. Warn with {@link pickWouldStrandStarters} beforehand; do not block.
 */
export function makePick(state: DraftState, input: MakePickInput): DraftState {
  if (isComplete(state)) {
    throw new DraftError("The draft is complete", "DRAFT_COMPLETE");
  }

  const onClock = currentTeam(state);
  if (onClock !== input.teamId) {
    throw new DraftError(
      `Team ${input.teamId} is not on the clock (${onClock ?? "none"} is)`,
      "NOT_ON_CLOCK",
    );
  }

  const player = input.pool.get(input.playerId);
  if (!player || draftedPlayerIds(state).has(input.playerId)) {
    throw new DraftError(`Player ${input.playerId} is not available`, "PLAYER_UNAVAILABLE");
  }

  const legality = canDraft(rosterFor(state, input.teamId, input.pool), player, input.shape);
  if (!legality.legal) {
    throw new DraftError(
      `Cannot draft ${input.playerId}: ${legality.reason}`,
      legality.reason ?? "NO_LEGAL_PICK",
    );
  }

  return appendPick(state, input.teamId, input.playerId, "MANUAL");
}

export interface AutoPickInput {
  readonly pool: ReadonlyMap<string, DraftablePlayer>;
  readonly shape: RosterShape;
  /** Queues by team ID. Absent or empty is fine — bots never have one. */
  readonly queues?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Make the pick on the clock automatically.
 *
 * Drives both clock expiry and every bot pick. The clock is hard: expiry always
 * produces a pick, so a draft never stalls waiting for someone who went to bed.
 */
export function makeAutoPick(state: DraftState, input: AutoPickInput): DraftState {
  if (isComplete(state)) {
    throw new DraftError("The draft is complete", "DRAFT_COMPLETE");
  }

  const teamId = currentTeam(state)!;
  const taken = draftedPlayerIds(state);
  const available = [...input.pool.values()].filter((player) => !taken.has(player.playerId));

  const result = autoPick({
    available,
    roster: rosterFor(state, teamId, input.pool),
    queue: input.queues?.get(teamId) ?? [],
    shape: input.shape,
    picksRemainingAfter: picksRemainingAfter(state, teamId),
  });

  if (!result) {
    throw new DraftError(`No legal pick available for team ${teamId}`, "NO_LEGAL_PICK");
  }

  return appendPick(state, teamId, result.player.playerId, result.source);
}

function appendPick(
  state: DraftState,
  teamId: string,
  playerId: string,
  source: DraftPick["source"],
): DraftState {
  const pickNumber = currentPickNumber(state);
  const { round } = pickPosition(pickNumber, state.order.length);

  return {
    ...state,
    picks: [...state.picks, { pickNumber, round, teamId, playerId, source }],
  };
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/**
 * When the current pick expires.
 *
 * Computed, never scheduled. The same function serves a 90-second live room and
 * a 24-hour slow draft; only the number differs, which is why slow drafts need
 * no real-time infrastructure at all.
 *
 * @param clockStartedAt unix seconds
 */
export function pickDeadline(clockStartedAt: number, draft: DraftRules): number {
  return clockStartedAt + draft.pickSeconds;
}

export function isPickExpired(deadline: number, now: number): boolean {
  return now >= deadline;
}

/** Seconds left, floored at zero. */
export function secondsRemaining(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}
