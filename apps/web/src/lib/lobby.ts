/**
 * The draft lobby's view model.
 *
 * Pure, and deliberately so. `apps/web` cannot render a component in a test —
 * both vitest projects are node-environment with no jsdom — so anything a
 * screen decides has to live somewhere a test can reach it. `lib/pot.ts` and
 * `lib/cluster.ts` are the pattern.
 *
 * The lobby's whole argument is that the order could not have been known in
 * advance, so **every fact here is derived from the draw, never restated**. The
 * pick labels come from the engine's own snake (`pickPosition`), the seed
 * recipe from `explainOrderDraw`, and the order from the recorded positions. A
 * lobby that computed the snake itself would be a second implementation of the
 * rotation the draft room already owns, and the two would disagree on the day
 * it mattered.
 */

import { explainOrderDraw, pickPosition } from "@rostr/core";

/** Which of the two lobby states a league is in. */
export type LobbyPhase = "BEFORE_DRAW" | "DRAWN";

export interface LobbySeat {
  readonly teamId: string;
  readonly name: string;
  readonly isBot: boolean;
  /** The viewer's own team. */
  readonly isYou: boolean;
  readonly isCommissioner: boolean;
  /** 1-based, once the order is drawn. `null` before it. */
  readonly position: number | null;
  /**
   * This seat's first two picks, as `1.04` labels — empty before the draw.
   *
   * Two because that is what the design shows and what a manager can act on
   * while the lobby is open; the room owns the rest.
   */
  readonly picks: readonly string[];
}

/** Why the draw button is not pressable. `null` means it is. */
export type DrawBlocker =
  | { readonly code: "NOT_COMMISSIONER" }
  | { readonly code: "TOO_EARLY"; readonly scheduledAt: Date }
  | { readonly code: "BELOW_MIN_HUMANS"; readonly humans: number; readonly required: number }
  | { readonly code: "ODD_FIELD"; readonly teams: number }
  | { readonly code: "POT_NOT_FUNDED"; readonly unfunded: number }
  | { readonly code: "ALREADY_DRAWN" };

/**
 * A condition that has to hold **when the draft time arrives**, listed while
 * there is still time to do something about it.
 *
 * ## Why this is separate from `DrawBlocker`
 *
 * They are computed from the same facts and answer different questions.
 * `DrawBlocker` answers "why is the button dead right now", first reason wins,
 * ordered to match the server's refusals. That is right for a button and useless
 * as a warning: before the draft time it always answers `TOO_EARLY`, so a
 * commissioner looking a week ahead at a five-team league would be told nothing
 * at all about the thing that will stop them.
 *
 * ## And it is the only thing that can prevent the failure
 *
 * Migration `0028` locks the field at `scheduledAt` on INSERT **and** DELETE, so
 * once the draft time passes nobody can join, nobody can leave, and no bot can
 * be added to square the field. The draw can only refuse. Every remedy has to
 * happen before that instant, which makes this list load-bearing rather than a
 * courtesy — and a league that reaches its deadline with any of these unresolved
 * does not draft at all, and refunds everyone 48 hours later (#170).
 *
 * So this reports **every** outstanding problem rather than the first: they all
 * have to be fixed, and finding out about the second one after fixing the first
 * may be finding out too late.
 */
export type ReadinessProblem =
  | { readonly code: "BELOW_MIN_HUMANS"; readonly humans: number; readonly required: number }
  | { readonly code: "ODD_FIELD"; readonly teams: number; readonly canUseBot: boolean }
  | { readonly code: "POT_NOT_FUNDED"; readonly unfunded: number };

export interface LobbyVerification {
  readonly slot: number;
  readonly blockhash: string;
  readonly seed: string;
  readonly drawnAt: Date;
  readonly scheduledAt: Date;
  /** The by-hand instructions, verbatim from `@rostr/core`. */
  readonly explanation: string;
}

export interface LobbyView {
  readonly phase: LobbyPhase;
  readonly scheduledAt: Date;
  /**
   * The server's clock, sent to the browser with the payload.
   *
   * The countdown must be measured against this and the *elapsed* time since
   * it arrived — never against `Date.now()` directly. The draft room learned
   * this the expensive way: a machine whose clock is minutes off computes a
   * deadline that has already passed and disables its own controls. Here the
   * cost is only a wrong-looking countdown, because the server refuses an early
   * draw regardless, but the rule is the same one.
   */
  readonly now: Date;
  readonly seats: readonly LobbySeat[];
  readonly humans: number;
  readonly minHumans: number;
  readonly drawBlocker: DrawBlocker | null;
  /**
   * Everything that will stop this league drafting, shown whether or not the
   * draft time has arrived. Empty means it is ready. See `ReadinessProblem`.
   */
  readonly readiness: readonly ReadinessProblem[];
  readonly verification: LobbyVerification | null;
  /** The viewer's own overall pick numbers, once drawn. */
  readonly yourPicks: readonly number[];
}

export interface LobbyInput {
  readonly leagueId: string;
  readonly rulesHash: string;
  readonly minHumans: number;
  readonly rounds: number;
  readonly scheduledAt: Date;
  readonly now: Date;
  readonly viewerTeamId: string | null;
  readonly isCommissioner: boolean;
  readonly commissionerTeamId: string | null;
  /**
   * Every team in the league.
   *
   * Ordered by `draft_position` once the draw has happened and by join slot
   * before it — the caller's query decides, because before the draw there is no
   * order to sort by and inventing one here would imply the draw had a result.
   */
  readonly teams: readonly {
    readonly teamId: string;
    readonly name: string;
    readonly isBot: boolean;
    readonly position: number | null;
  }[];
  /** Whether this league plays for a pot, and so whether stakes are required. */
  readonly hasPot: boolean;
  /**
   * Members of a pot league who have not staked, or who staked and have since
   * been refunded. Zero for a free league.
   *
   * A count rather than the members themselves: the lobby says how many are
   * outstanding, and naming who has not paid turns a scheduling problem into a
   * public accusation on a screen everybody in the league can see.
   */
  readonly unfundedMembers: number;
  /** `null` until the order is drawn. */
  readonly draw: {
    readonly slot: number;
    readonly blockhash: string;
    readonly seed: string;
    readonly drawnAt: Date;
  } | null;
}

/** `1.04` — round, then the pick within it, zero-padded to two digits. */
export function pickLabel(pickNumber: number, teamCount: number): string {
  const { round, pickInRound } = pickPosition(pickNumber, teamCount);
  return `${round}.${String(pickInRound).padStart(2, "0")}`;
}

/**
 * Every overall pick number belonging to one position in the order.
 *
 * Walks the engine's own `pickPosition` rather than doing the snake arithmetic,
 * which the design handoff names explicitly as a fact that must not be authored
 * twice: from 3.04 to 4.09 is sixteen picks, and counting it by hand is how the
 * prototype got it wrong.
 */
export function picksForPosition(
  position: number,
  teamCount: number,
  rounds: number,
): readonly number[] {
  const picks: number[] = [];
  for (let pick = 1; pick <= teamCount * rounds; pick++) {
    if (pickPosition(pick, teamCount).orderIndex === position - 1) picks.push(pick);
  }
  return picks;
}

export function buildLobbyView(input: LobbyInput): LobbyView {
  const teamCount = input.teams.length;
  const humans = input.teams.filter((team) => !team.isBot).length;

  const seats = input.teams.map((team): LobbySeat => {
    const picks =
      input.draw && team.position !== null
        ? picksForPosition(team.position, teamCount, input.rounds)
            .slice(0, 2)
            .map((pick) => pickLabel(pick, teamCount))
        : [];

    return {
      teamId: team.teamId,
      name: team.name,
      isBot: team.isBot,
      isYou: team.teamId === input.viewerTeamId,
      isCommissioner: team.teamId === input.commissionerTeamId,
      position: team.position,
      picks,
    };
  });

  const viewer = seats.find((seat) => seat.isYou);
  const yourPicks =
    input.draw && viewer?.position != null
      ? picksForPosition(viewer.position, teamCount, input.rounds).slice(0, 2)
      : [];

  return {
    phase: input.draw ? "DRAWN" : "BEFORE_DRAW",
    scheduledAt: input.scheduledAt,
    now: input.now,
    seats,
    humans,
    minHumans: input.minHumans,
    drawBlocker: drawBlocker(input, humans),
    readiness: readiness(input, humans),
    verification: input.draw
      ? {
          slot: input.draw.slot,
          blockhash: input.draw.blockhash,
          seed: input.draw.seed,
          drawnAt: input.draw.drawnAt,
          scheduledAt: input.scheduledAt,
          explanation: explainOrderDraw({
            leagueId: input.leagueId,
            rulesHash: input.rulesHash,
            slot: input.draw.slot,
            blockhash: input.draw.blockhash,
          }),
        }
      : null,
    yourPicks,
  };
}

/**
 * The same three refusals `drawDraftOrder` makes, computed for the screen.
 *
 * This is a courtesy and the server is the rule — the button being enabled has
 * never been what permits a draw. It is here so the lobby can say *which* thing
 * is missing rather than presenting a live button that answers 425, and the
 * order matches the server's so the two cannot disagree about which reason
 * comes first.
 */
function drawBlocker(input: LobbyInput, humans: number): DrawBlocker | null {
  if (input.draw) return { code: "ALREADY_DRAWN" };
  if (!input.isCommissioner) return { code: "NOT_COMMISSIONER" };
  if (input.now.getTime() < input.scheduledAt.getTime()) {
    return { code: "TOO_EARLY", scheduledAt: input.scheduledAt };
  }
  if (humans < input.minHumans) {
    return { code: "BELOW_MIN_HUMANS", humans, required: input.minHumans };
  }
  // Same order as `drawDraftOrder`: a short league is told it is short before it
  // is told it is lopsided, because that is the more useful fact and because a
  // screen naming a different reason than the server would is the two-sources
  // problem this repo keeps paying for.
  if (input.teams.length % 2 !== 0) {
    return { code: "ODD_FIELD", teams: input.teams.length };
  }
  if (input.hasPot && input.unfundedMembers > 0) {
    return { code: "POT_NOT_FUNDED", unfunded: input.unfundedMembers };
  }
  return null;
}

/**
 * Everything outstanding, whether or not the draft time has come.
 *
 * All of them, not the first: they must all be true at `scheduledAt`, and after
 * that instant none of them can be fixed. Learning about the second problem
 * after solving the first may be learning about it too late.
 *
 * The conditions are the server's, in the server's order — this is a courtesy
 * copy of `drawDraftOrder`'s refusals, and a courtesy that disagreed with the
 * rule would be worse than none.
 */
function readiness(input: LobbyInput, humans: number): ReadinessProblem[] {
  const out: ReadinessProblem[] = [];

  if (humans < input.minHumans) {
    out.push({ code: "BELOW_MIN_HUMANS", humans, required: input.minHumans });
  }

  if (input.teams.length % 2 !== 0) {
    // A bot squares a free league and can never square a pot league, because it
    // has no wallet and pays no buy-in. The screen has to say which, since the
    // two have completely different remedies: press a button, or find a person.
    out.push({ code: "ODD_FIELD", teams: input.teams.length, canUseBot: !input.hasPot });
  }

  if (input.hasPot && input.unfundedMembers > 0) {
    out.push({ code: "POT_NOT_FUNDED", unfunded: input.unfundedMembers });
  }

  return out;
}
