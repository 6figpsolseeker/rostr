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
  | { readonly code: "ALREADY_DRAWN" };

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
  return null;
}
