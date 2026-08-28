import { NextResponse } from "next/server";
import {
  gameAvailability,
  indexScoringRules,
  scorePlayer,
  slotIsLocked,
  slotLocksAt,
  startingSlots,
} from "@rostr/core";
import { autolineupChoices, buildRosterShape, NFL } from "@rostr/core";
import type { LineupAssignment } from "@rostr/core";
import {
  autolineupCandidate,
  getAutofillEnabled,
  LineupError,
  loadAverages,
  loadByeWeeks,
  loadLineup,
  loadProjectedPoints,
  loadKickoffs,
  loadRosterForWeek,
  loadTbdKickoffs,
  loadWeekStats,
  overageFor,
  overLimitNotice,
  setAutofillEnabled,
  setLineup,
} from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

const STATUS: Record<string, number> = {
  LEAGUE_NOT_FOUND: 404,
  TEAM_NOT_IN_LEAGUE: 403,
  INVALID_LINEUP: 422,
  // Retryable, unlike every other code here. Nothing about the lineup is wrong —
  // somebody else wrote the slot between validation and the write, so the client
  // re-reads and submits again. 409 rather than 422: the request was well formed.
  LINEUP_MOVED: 409,
  // The roster holds more players than the limit, so the lineup is frozen until
  // somebody is released. A conflict with the team's state rather than anything
  // wrong with the lineup submitted, so 409 and not 422.
  ROSTER_OVER_LIMIT: 409,
  SLOT_TYPE_UNKNOWN: 500,
  // A league whose games are not ingested cannot enforce a kickoff lock, so it
  // refuses rather than accepting a lineup it could not police.
  //
  // **409 is a partial answer to #98 and this comment used to overstate it
  // twice.** It said the code "fell through to 400 with no diagnosis"; the catch
  // already returned the error message, and #98 says so itself ("the diagnosis
  // is right"). What #98 actually asks for is **503** — the manager did nothing
  // wrong and there is nothing they can do, which is a server-state problem
  // wearing a 4xx. Moving it out of the 400 bucket is an improvement and not the
  // fix; #98 stays open for the status itself.
  SCHEDULE_MISSING: 409,
};

function weekOf(request: Request): number {
  const raw = new URL(request.url).searchParams.get("week");
  const week = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(week) && week > 0 ? week : 1;
}

/**
 * Your lineup for a week, with everything needed to edit it.
 *
 * Locks are computed and sent per slot rather than left to the client, so the
 * screen and the server cannot disagree about what has kicked off. The server
 * checks again on write regardless — this is for showing, not for deciding.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const week = weekOf(request);

  try {
    const context = await draftContext(id);
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const client = db();
    const roster = await loadRosterForWeek(client, context.myTeamId, context.season, week);
    const assignments = await loadLineup(client, context.myTeamId, week, context.rules);

    // Roster plus whoever is standing in the stored lineup, exactly as
    // `setLineup` builds it. The screen must agree with the server about which
    // slots are locked, and the occupant of a locked slot may no longer be
    // rostered — that is the whole point of keying locks on the player.
    const kickoffs = await loadKickoffs(
      client,
      [
        ...new Set(
          [...roster.keys(), ...assignments.map((entry) => entry.playerId)].filter(
            (playerId): playerId is string => playerId !== null,
          ),
        ),
      ],
      context.season,
      week,
    );

    // Bye weeks, and which fixtures carry a stand-in kickoff. Both are loaded
    // separately from the kickoffs above and deliberately so: `loadKickoffs` is
    // the lock oracle and widening it is how the lock bypass happened. These
    // only decide what the screen says, and can mislabel a row without
    // unlocking one — the lock uses the conservative time exactly as stored.
    const byeWeeks = await loadByeWeeks(client, [...roster.keys()], context.season);
    const tbdKickoffs = await loadTbdKickoffs(client, [...roster.keys()], context.season, week);

    // Points so far this week, so a manager can see what their lineup is doing
    // while it is doing it.
    const stats = await loadWeekStats(client, NFL.key, context.season, week);
    const scoring = indexScoringRules(context.rules.scoring);

    // What the autofill would rank on, and what it would compare against. Both
    // are sent raw rather than as a pre-computed "hot" badge: the numbers are
    // the durable part, and how a screen chooses to dramatise them is not.
    const playerIds = [...roster.keys()];
    const projected = await loadProjectedPoints(client, context.season, week, context.rules);
    const averages = await loadAverages(client, playerIds, context.season, week, context.rules);

    const autofillEnabled = await getAutofillEnabled(client, context.myTeamId);

    // Same function the write path refuses with. See the response below.
    const editingNotice = overLimitNotice(
      await overageFor(client, context.myTeamId, context.rules),
    );

    const now = Math.floor(Date.now() / 1000);

    /*
      What the autofill would do, computed here rather than in the browser.

      The screen used to offer a checkbox and no account of what turning it on
      does — which is the one thing worth knowing before trusting it with a week
      that counts. `autolineupChoices` is the same function `autoFillLineup`
      fills with, so the preview cannot name a different player from the write
      **for the same inputs** — and one of those inputs is the clock below. This
      one passes request time and the write passes whenever the cron ran, so a
      preview taken before a kickoff can name a player the write is no longer
      allowed to start. That is a forecast decaying, not the two disagreeing.

      **Locked slots are passed in, not filtered out.** A locked player is
      unavailable to every other slot, so omitting them would let the preview
      offer somebody who is already playing — and the FLEX preview in particular
      would be wrong every Sunday afternoon.
    */
    const shape = buildRosterShape(context.rules.roster, NFL);
    const currentAssignments: LineupAssignment[] = startingSlots(shape).map((slot) => {
      const found = assignments.find(
        (entry) => entry.slotType === slot.slotType && entry.slotIndex === slot.slotIndex,
      );
      return found ?? { slotType: slot.slotType, slotIndex: slot.slotIndex, playerId: null };
    });

    const choices = autolineupChoices({
      shape,
      // Stashed players are out of the rotation, exactly as in `autoFillLineup`.
      // A preview that offered one would name a starter the write will not make.
      roster: [...roster.values()]
        .filter((player) => !player.onIr)
        .map((player) =>
          autolineupCandidate(player, {
            averageMilliPoints: averages.get(player.playerId) ?? null,
            projectedMilliPoints: projected.get(player.playerId) ?? null,
          }),
        ),
      mode: context.rules.roster.autofill,
      locked: currentAssignments.filter((entry) => slotIsLocked(entry, kickoffs, now)),
      // The same instant the locks above are read at. The autofill will not put
      // a player whose game has started into a slot it finds empty, so neither
      // may the preview of it.
      now,
    });

    /*
      Only slots the manager has left empty.

      The autofill "only touches slots you leave empty" — the label already says
      so — and a preview covering filled slots would read as a threat to replace
      a starter somebody deliberately chose.
    */
    /*
      The roster a slot could draw on, ignoring the clock.

      `autolineupChoices` reports that a slot is going unfilled, not why, and the
      two reasons need different words in front of a manager. This asks the
      narrower question the screen needs: does he roster anybody who plays there?
    */
    const eligibleForSlot = (slotType: string) => {
      const slot = startingSlots(shape).find((entry) => entry.slotType === slotType);
      if (!slot) return [];
      return [...roster.values()]
        .filter((player) => !player.onIr)
        .filter((player) =>
          player.positions.some((position) => slot.eligiblePositions.includes(position)),
        );
    };

    /** The same test `autolineup` filters the pool with, at the same instant. */
    const hasKickedOff = (player: { kickoffAt: number | null }): boolean =>
      player.kickoffAt !== null && now >= player.kickoffAt;

    const preview = choices.filter((choice) => {
      const current = currentAssignments.find(
        (entry) => entry.slotType === choice.slotType && entry.slotIndex === choice.slotIndex,
      );
      /*
        A slot the autofill will leave empty stays in the list, with a null
        player. It used to be filtered out here, which rendered it identically
        to a slot already set — nothing — under a heading whose whole job is
        naming what the autofill will do.

        Those are the slots the manager has to act on himself, and there are two
        reasons a slot reaches that state — see `emptyReason` below. Hiding them
        removed the only signal that anything was outstanding.
      */
      return current?.playerId == null;
    });

    return NextResponse.json({
      week,
      /** From the frozen rules, so the screen cannot invent an allowance. */
      irSlots: context.rules.roster.irSlots,
      /*
        Whether this team may edit at all, and the sentence if not.

        Composed here from the same function `setLineup` throws with, so the
        screen and the server cannot disagree about it — and it is the only way
        that sentence gets a test, because `apps/web` cannot render a component
        in one.
      */
      editing: {
        open: editingNotice === null,
        notice: editingNotice,
      },
      autofill: {
        enabled: autofillEnabled ?? true,
        /**
         * Per empty slot: who it would start, and the best player left on the
         * bench that it passed over. Empty when nothing is outstanding, which is
         * the ordinary state of a lineup somebody has set.
         */
        preview: preview.map((choice) => ({
          slotType: choice.slotType,
          slotIndex: choice.slotIndex,
          playerId: choice.playerId,
          runnerUpId: choice.runnerUpId,
          runnerUpReason: choice.runnerUpReason,
          /*
            Why a slot is being left empty, because the two reasons ask the
            manager for different things and the screen must not guess.

            ALL_PLAYING — he rosters somebody who could fill it, and every one
            of them has kicked off. The move is a free agent whose game has not.
            NONE_ELIGIBLE — nobody on the roster plays that position at all, or
            the ones who do are already starting elsewhere. Signing a free agent
            of the right position is the move, and it is not urgent in the same
            way.

            Computed here rather than in `autolineupChoices` because it is a
            question about this screen, not about the fill: the autofill's answer
            is the same either way.
          */
          emptyReason:
            choice.playerId !== null
              ? null
              : eligibleForSlot(choice.slotType).some((player) => !hasKickedOff(player))
                ? ("NONE_ELIGIBLE" as const)
                : ("ALL_PLAYING" as const),
        })),
        /** Frozen in the league's rules, so it is the same for everybody. */
        mode: context.rules.roster.autofill,
      },
      slots: startingSlots(buildRosterShape(context.rules.roster, NFL)).map((slot) => {
        const assignment = assignments.find(
          (entry) => entry.slotType === slot.slotType && entry.slotIndex === slot.slotIndex,
        ) ?? { slotType: slot.slotType, slotIndex: slot.slotIndex, playerId: null };

        const locksAt = slotLocksAt(assignment, kickoffs);

        return {
          slotType: slot.slotType,
          slotIndex: slot.slotIndex,
          eligiblePositions: slot.eligiblePositions,
          playerId: assignment.playerId,
          locksAt,
          // Ask the shared helper rather than re-deriving it from `locksAt`.
          // The two disagree for a player the map does not know: `locksAt` is
          // null so the screen would offer the edit, while the server refuses.
          // A UI that offers an edit the server rejects is the failure the
          // draft clock already taught us to avoid.
          locked: slotIsLocked(assignment, kickoffs, now),
        };
      }),
      roster: [...roster.values()].map((player) => ({
        playerId: player.playerId,
        name: player.fullName,
        positions: player.positions,
        // Shown, never enforced *here*. The lock is `locked` above, computed
        // from kickoff; a designation arriving on the Sunday must not be able to
        // invalidate a lineup that was legal when it was set. The autofill may
        // now rank on it, and only that — see `DECISIONS.md` and issue #269.
        imageUrl: player.imageUrl,
        teamRef: player.teamRef,
        injuryDesignation: player.injuryDesignation,
        /**
         * On injured reserve. Unlike the designation above this is **not**
         * display-only: it decides whether he counts against the roster limit
         * and keeps him out of the autofill.
         */
        onIr: player.onIr,
        /**
         * Who he plays this week, from the fixture already stored. Sent as the
         * two raw facts rather than a composed "vs NO" — the screen decides how
         * to say it, and `lib/opponent.ts` is where that decision is tested.
         */
        opponentRef: player.opponentRef,
        isHome: player.isHome,
        kickoffAt: player.kickoffAt,
        /**
         * How settled this player's week is. A bye, a fixture whose kickoff
         * time the NFL has not fixed, and an ordinary game mean quite
         * different things to someone choosing a lineup — and the first two
         * are indistinguishable from a kickoff alone. The screen is told which
         * it is rather than inferring "bye" from an absence.
         */
        availability: gameAvailability({
          kickoffAt: player.kickoffAt,
          kickoffTbd: tbdKickoffs.has(player.playerId),
          byeWeek: byeWeeks.get(player.playerId) ?? null,
          week,
        }),
        milliPoints: scorePlayer(stats.get(player.playerId) ?? [], scoring),
        /**
         * This week's projection, under this league's own scoring. `null` when
         * the provider has not published one — a rookie, or a week not yet
         * synced — which is also when the autofill falls back to the average
         * for that player alone.
         */
        projectedMilliPoints: projected.get(player.playerId) ?? null,
        /** Season to date. `null` before week 2, when there is no history. */
        averageMilliPoints: averages.get(player.playerId) ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof LineupError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}

/**
 * Replace your lineup.
 *
 * The team comes from the session. Legality and locks are decided by
 * `setLineup`, against what is currently stored — never against anything the
 * client claims about its own state.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.userId) {
      return NextResponse.json({ error: "Sign in to set a lineup" }, { status: 401 });
    }
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const body = (await request.json()) as {
      week?: number;
      assignments?: LineupAssignment[];
    };

    if (!body.week || !Array.isArray(body.assignments)) {
      return NextResponse.json({ error: "week and assignments are required" }, { status: 400 });
    }

    const saved = await setLineup(db(), {
      leagueId: id,
      teamId: context.myTeamId,
      week: body.week,
      assignments: body.assignments,
      now: Math.floor(Date.now() / 1000),
    });

    return NextResponse.json({ week: body.week, assignments: saved });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof LineupError) {
      return NextResponse.json(
        { error: error.message, code: error.code, problems: error.problems },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}

/**
 * Turn your own autofill on or off.
 *
 * Separate from PUT because it is a different kind of thing: PUT replaces a
 * lineup and is subject to locks, this changes what happens at the *next* lock
 * and rewrites nothing already stored. Turning it off does not empty a lineup
 * that has already been filled for you.
 *
 * The team comes from the session, never from the request — the same rule as
 * everywhere else here, and the reason the join route stopped accepting a
 * userId.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    if (!context.myTeamId) {
      return NextResponse.json({ error: "You are not in this league" }, { status: 403 });
    }

    const body = (await request.json()) as { autofillEnabled?: unknown };
    if (typeof body.autofillEnabled !== "boolean") {
      return NextResponse.json({ error: "autofillEnabled must be a boolean" }, { status: 400 });
    }

    await setAutofillEnabled(db(), context.myTeamId, body.autofillEnabled);
    return NextResponse.json({ autofillEnabled: body.autofillEnabled });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
