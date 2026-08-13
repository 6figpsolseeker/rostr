/**
 * Setting a lineup.
 *
 * Pure, like everything else in `core`: it validates an arrangement and reports
 * what is wrong with it. Nothing here reads a clock or a database — which is
 * what lets the same function check a manager's edit, a bot's lineup, and the
 * autolineup, without three subtly different ideas of what is legal.
 *
 * ## Every problem at once
 *
 * Validation returns a list rather than throwing on the first fault. A manager
 * rearranging nine slots should see everything wrong in one pass, not discover
 * the next fault after fixing this one. Same convention as league validation.
 *
 * ## Locks are the load-bearing part
 *
 * A slot locks at the kickoff of **that player's** game, not at the first
 * kickoff of the week. So a manager can still move their Sunday players while
 * their Thursday player is already locked — which is what every real platform
 * does, and what makes a Sunday-morning injury actionable.
 *
 * Getting this wrong in the permissive direction means someone starts a player
 * after seeing him score. `lockedAssignments` exists so a caller cannot forget
 * to ask.
 */

import type { RosterShape } from "../draft/roster.js";

/** One filled slot. `playerId` is `null` for a slot left empty. */
export interface LineupAssignment {
  readonly slotType: string;
  /** 0-based, distinguishing the two RB slots from each other. */
  readonly slotIndex: number;
  readonly playerId: string | null;
}

/** What a lineup needs to know about a player, and nothing more. */
export interface LineupPlayer {
  readonly playerId: string;
  readonly positions: readonly string[];
  /** Unix seconds of this player's game this week. `null` when on a bye. */
  readonly kickoffAt: number | null;
}

export type LineupProblemCode =
  | "UNKNOWN_SLOT"
  | "DUPLICATE_SLOT"
  | "NOT_ON_ROSTER"
  | "PLAYER_TWICE"
  | "POSITION_NOT_ELIGIBLE"
  | "SLOT_LOCKED"
  | "PLAYER_LOCKED"
  | "STARTER_EMPTY";

export interface LineupProblem {
  readonly code: LineupProblemCode;
  readonly message: string;
  readonly slotType?: string;
  readonly slotIndex?: number;
  readonly playerId?: string;
}

/**
 * When each relevant player's game kicks off this week, in Unix seconds.
 * `null` means a bye — a known player with no game.
 *
 * **Deliberately not the roster.** A lock is a fact about a game that has
 * started, not about who owns the player now, and conflating the two is what let
 * a manager reopen a Thursday slot by cutting the man in it: the roster map
 * excludes released players, so the slot's occupant vanished and an absent
 * player read as "never locks".
 *
 * The caller must cover the roster **and** everyone named in the stored lineup —
 * the union, because the whole point is that the occupant of a locked slot may
 * no longer be rostered. A player missing from this map locks, so a caller who
 * under-populates it gets refusals rather than a silent bypass.
 */
export type KickoffTimes = ReadonlyMap<string, number | null>;

export interface ValidateLineupInput {
  readonly assignments: readonly LineupAssignment[];
  readonly shape: RosterShape;
  /**
   * The team's roster, keyed by player ID.
   *
   * Answers "may I start this player" — ownership and eligibility. It no longer
   * answers "has his game started"; see `kickoffs`.
   */
  readonly roster: ReadonlyMap<string, LineupPlayer>;
  /**
   * Kickoffs for the roster and for whoever is standing in the stored lineup.
   *
   * Required, not optional-with-a-fallback. An optional filter that defaults to
   * permissive is the shape that produced the `loadProjections` defect, and here
   * the permissive default is the bug being fixed.
   */
  readonly kickoffs: KickoffTimes;
  /**
   * What is currently in each slot. Needed to tell an edit from a no-op: a
   * locked slot may keep its player, it simply may not change.
   */
  readonly current?: readonly LineupAssignment[];
  /** Unix seconds. Omit to skip lock checking — previews, not submissions. */
  readonly now?: number;
  /**
   * Whether to complain about empty starting slots.
   *
   * Off by default. A manager part-way through setting a lineup on Tuesday has
   * empty slots and does not need telling; the check matters at the moment the
   * week scores, which is a different caller.
   */
  readonly requireFull?: boolean;
}

const key = (slotType: string, slotIndex: number): string => `${slotType}#${slotIndex}`;

/**
 * Check a proposed lineup.
 *
 * @returns every problem found, or an empty array
 */
export function validateLineup(input: ValidateLineupInput): readonly LineupProblem[] {
  const { assignments, shape, roster, kickoffs, current, now, requireFull } = input;
  const problems: LineupProblem[] = [];

  const slots = new Map(
    shape.starters.map((slot, index) => [
      key(slot.slotType, indexWithinType(shape, index)),
      slot,
    ]),
  );

  const seenSlots = new Set<string>();
  const seenPlayers = new Map<string, { slotType: string; slotIndex: number }>();

  const currentBySlot = new Map(
    (current ?? []).map((entry) => [key(entry.slotType, entry.slotIndex), entry.playerId]),
  );

  for (const assignment of assignments) {
    const slotKey = key(assignment.slotType, assignment.slotIndex);
    const slot = slots.get(slotKey);

    if (!slot) {
      problems.push({
        code: "UNKNOWN_SLOT",
        message: `This league has no ${assignment.slotType} slot ${assignment.slotIndex + 1}`,
        slotType: assignment.slotType,
        slotIndex: assignment.slotIndex,
      });
      continue;
    }

    if (seenSlots.has(slotKey)) {
      problems.push({
        code: "DUPLICATE_SLOT",
        message: `${assignment.slotType} slot ${assignment.slotIndex + 1} was filled twice`,
        slotType: assignment.slotType,
        slotIndex: assignment.slotIndex,
      });
      continue;
    }
    seenSlots.add(slotKey);

    // A locked slot may keep what it has; it may not change. Comparing against
    // the current lineup rather than rejecting the slot outright is what lets a
    // manager submit their whole lineup on Sunday without the Thursday slot
    // making the submission fail.
    const wasLocked =
      now !== undefined && isSlotLocked(currentBySlot.get(slotKey) ?? null, kickoffs, now);

    if (wasLocked && currentBySlot.get(slotKey) !== assignment.playerId) {
      problems.push({
        code: "SLOT_LOCKED",
        message:
          `${assignment.slotType} slot ${assignment.slotIndex + 1} is locked — ` +
          `that player's game has kicked off`,
        slotType: assignment.slotType,
        slotIndex: assignment.slotIndex,
      });
      continue;
    }

    if (assignment.playerId === null) continue;

    const player = roster.get(assignment.playerId);
    if (!player) {
      problems.push({
        code: "NOT_ON_ROSTER",
        message: `${assignment.playerId} is not on this roster`,
        slotType: assignment.slotType,
        slotIndex: assignment.slotIndex,
        playerId: assignment.playerId,
      });
      continue;
    }

    // A player whose own game has kicked off can only be kept where he already
    // is, never moved into a slot. The check above guards the player leaving a
    // slot; without this one, an empty slot — which never locks — would let a
    // manager start a player after watching him score.
    if (
      now !== undefined &&
      currentBySlot.get(slotKey) !== assignment.playerId &&
      isSlotLocked(assignment.playerId, kickoffs, now)
    ) {
      problems.push({
        code: "PLAYER_LOCKED",
        message:
          `${assignment.playerId}'s game has kicked off — ` +
          `they can no longer be started in ${assignment.slotType} slot ${assignment.slotIndex + 1}`,
        slotType: assignment.slotType,
        slotIndex: assignment.slotIndex,
        playerId: assignment.playerId,
      });
      continue;
    }

    const already = seenPlayers.get(assignment.playerId);
    if (already) {
      problems.push({
        code: "PLAYER_TWICE",
        message:
          `${assignment.playerId} is in both ${already.slotType} ` +
          `slot ${already.slotIndex + 1} and ${assignment.slotType} ` +
          `slot ${assignment.slotIndex + 1}`,
        slotType: assignment.slotType,
        slotIndex: assignment.slotIndex,
        playerId: assignment.playerId,
      });
      continue;
    }
    seenPlayers.set(assignment.playerId, {
      slotType: assignment.slotType,
      slotIndex: assignment.slotIndex,
    });

    // Eligibility comes from the slot definition, which came from the sport
    // registry. Nothing here knows what a FLEX accepts.
    const eligible = player.positions.some((position) =>
      slot.eligiblePositions.includes(position),
    );
    if (!eligible) {
      problems.push({
        code: "POSITION_NOT_ELIGIBLE",
        message:
          `${assignment.playerId} (${player.positions.join("/")}) cannot start at ` +
          `${assignment.slotType}`,
        slotType: assignment.slotType,
        slotIndex: assignment.slotIndex,
        playerId: assignment.playerId,
      });
    }
  }

  if (requireFull) {
    for (const [slotKey, slot] of slots) {
      const filled = assignments.find(
        (assignment) => key(assignment.slotType, assignment.slotIndex) === slotKey,
      );
      if (!filled || filled.playerId === null) {
        problems.push({
          code: "STARTER_EMPTY",
          message: `${slot.slotType} is empty`,
          slotType: slot.slotType,
        });
      }
    }
  }

  return problems;
}

/**
 * The index of a starter *within its own slot type*.
 *
 * `shape.starters` is a flat list, so the two running back slots are entries 1
 * and 2 of the whole roster. A manager thinks of them as RB1 and RB2, and so
 * does the database's `(slot_type_id, slot_index)`.
 */
function indexWithinType(shape: RosterShape, position: number): number {
  const slotType = shape.starters[position]!.slotType;
  let index = 0;
  for (let i = 0; i < position; i++) {
    if (shape.starters[i]!.slotType === slotType) index++;
  }
  return index;
}

/** Every slot a league has, in roster order, as `(slotType, slotIndex)`. */
export function startingSlots(
  shape: RosterShape,
): readonly { slotType: string; slotIndex: number; eligiblePositions: readonly string[] }[] {
  return shape.starters.map((slot, position) => ({
    slotType: slot.slotType,
    slotIndex: indexWithinType(shape, position),
    eligiblePositions: slot.eligiblePositions,
  }));
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/**
 * Whether a slot holding this player is locked.
 *
 * An **empty slot never locks**. That is deliberate and worth stating: a manager
 * who left a slot empty can still fill it on Sunday afternoon, because nothing
 * has happened in that slot yet that anyone could react to. Locking empty slots
 * at the week's first kickoff would punish forgetting rather than prevent
 * cheating.
 *
 * A player on a **bye never locks** either — there is no game to have started.
 *
 * **An unknown player locks.** That is the third case, and it used to be missing:
 * `roster.get(id)?.kickoffAt` answered `undefined` both for a bye and for a
 * player who was not in the map at all, and both read as "never locks". Since the
 * map excluded released players, cutting the man in a slot reopened it — see
 * `KickoffTimes` for why the lock no longer consults a roster at all. Refusing an
 * edit we cannot price is the same direction `blockTime` takes: a refusal costs a
 * retry and is visible, a wrong "unlocked" is invisible and decides a matchup.
 */
function isSlotLocked(playerId: string | null, kickoffs: KickoffTimes, now: number): boolean {
  if (playerId === null) return false;

  // `has`, not `?? undefined` — that collapse is what hid the bug. A bye is a
  // known player with no game; an absent player is a question we cannot answer.
  if (!kickoffs.has(playerId)) return true;

  const kickoff = kickoffs.get(playerId) ?? null;
  if (kickoff === null) return false;

  return now >= kickoff;
}

/** Which of the current assignments can no longer be changed. */
export function lockedAssignments(
  current: readonly LineupAssignment[],
  kickoffs: KickoffTimes,
  now: number,
): readonly LineupAssignment[] {
  return current.filter((assignment) => isSlotLocked(assignment.playerId, kickoffs, now));
}

/**
 * Whether this slot can still be changed.
 *
 * Exported so the screen and the server share one implementation of the rule. A
 * UI that re-derives it can disagree with the server, and the direction that
 * matters is offering an edit the server will refuse.
 */
export function slotIsLocked(
  assignment: LineupAssignment,
  kickoffs: KickoffTimes,
  now: number,
): boolean {
  return isSlotLocked(assignment.playerId, kickoffs, now);
}

/**
 * When a slot locks, or `null` if it never will.
 *
 * For display: "locks in 2h 14m" is the difference between a manager who knows
 * their deadline and one who finds out afterwards.
 */
export function slotLocksAt(
  assignment: LineupAssignment,
  kickoffs: KickoffTimes,
): number | null {
  if (assignment.playerId === null) return null;
  return kickoffs.get(assignment.playerId) ?? null;
}

/** Whether a whole lineup is now beyond editing. */
export function lineupIsFullyLocked(
  current: readonly LineupAssignment[],
  kickoffs: KickoffTimes,
  now: number,
): boolean {
  const fillable = current.filter((assignment) => assignment.playerId !== null);
  if (fillable.length === 0) return false;

  return fillable.every((assignment) => isSlotLocked(assignment.playerId, kickoffs, now));
}
