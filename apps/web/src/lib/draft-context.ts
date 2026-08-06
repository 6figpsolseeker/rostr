import "server-only";

import { buildRosterShape, NFL } from "@rostr/core";
import type { DraftablePlayer, LeagueRules, RosterShape } from "@rostr/core";
import { getLeagueRules, loadDraftBoard, teamForUser } from "@rostr/db";
import type { DraftBoardEntry } from "@rostr/db";
import { db } from "./db";
import { currentUser } from "./session";

/**
 * Everything a draft route needs, resolved once.
 *
 * The important part is `myTeamId`: it comes from the session and the league's
 * team rows, never from the request. A route that accepted a team ID would let
 * anyone draft for anyone.
 */
export interface DraftContext {
  readonly leagueId: string;
  readonly userId: string | null;
  /** The team this user manages here, or `null` if they are not a member. */
  readonly myTeamId: string | null;
  readonly isCommissioner: boolean;
  readonly rules: LeagueRules;
  readonly shape: RosterShape;
  readonly season: number;
}

export class DraftContextError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DraftContextError";
  }
}

export async function draftContext(leagueId: string): Promise<DraftContext> {
  const client = db();

  const [league] = await client.query<{
    season: number;
    commissioner_id: string;
  }>("SELECT season, commissioner_id FROM leagues WHERE id = $1", [leagueId]);
  if (!league) throw new DraftContextError("League not found", 404);

  const stored = await getLeagueRules(client, leagueId);
  if (!stored) throw new DraftContextError("League has no rules", 500);

  const user = await currentUser();
  const team = user ? await teamForUser(client, leagueId, user.id) : null;

  return {
    leagueId,
    userId: user?.id ?? null,
    myTeamId: team?.teamId ?? null,
    isCommissioner: user !== null && league.commissioner_id === user.id,
    rules: stored.rules,
    shape: buildRosterShape(stored.rules.roster, NFL),
    season: Number(league.season),
  };
}

// ---------------------------------------------------------------------------
// The player pool
// ---------------------------------------------------------------------------

interface CachedBoard {
  readonly entries: readonly DraftBoardEntry[];
  readonly pool: ReadonlyMap<string, DraftablePlayer>;
  readonly loadedAt: number;
}

/**
 * The board is a thousand rows and changes only when the stats sync runs, so it
 * is cached rather than re-queried on every pick. Sixty seconds: long enough to
 * matter during a fast draft, short enough that a newly synced player appears
 * within a round.
 *
 * Cached on `globalThis` because Next recreates modules across hot reloads.
 */
const BOARD_TTL_MS = 60_000;

export async function draftBoard(season: number): Promise<CachedBoard> {
  const cache = globalThis as { __rostrBoards?: Map<number, CachedBoard> };
  cache.__rostrBoards ??= new Map();

  const existing = cache.__rostrBoards.get(season);
  if (existing && Date.now() - existing.loadedAt < BOARD_TTL_MS) return existing;

  const entries = await loadDraftBoard(db(), NFL.key, season);
  const board: CachedBoard = {
    entries,
    pool: new Map(
      entries.map((entry) => [
        entry.playerId,
        { playerId: entry.playerId, positions: entry.positions, rank: entry.rank },
      ]),
    ),
    loadedAt: Date.now(),
  };

  cache.__rostrBoards.set(season, board);
  return board;
}
