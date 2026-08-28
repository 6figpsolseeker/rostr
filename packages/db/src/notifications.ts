/**
 * Everything waiting on you, across every league.
 *
 * Drop 9 asks for a bell holding all of it and an urgent strip carrying the most
 * pressing item. This is the source both read from.
 *
 * ## Every item here is derived, and none is stored
 *
 * There is no notifications table and there should not be one. A stored
 * notification is a second copy of a fact that already exists — a draft clock, a
 * veto deadline, an invitation row — and the copy is free to disagree with the
 * original, go stale, or survive the thing it described. Everything below is a
 * query against the fact itself, so a trade that resolves stops being a
 * notification because it stopped being true, not because something remembered
 * to delete a row.
 *
 * The cost is that this runs on every poll rather than being handed a queue. At
 * a few leagues per person that is a handful of indexed reads; if it ever is
 * not, the answer is a cache with an expiry, not a table with a lifecycle.
 *
 * ## What is deliberately not here
 *
 * The design lists **"lineup unset near kickoff"** as an urgent item. It is,
 * everywhere else — and here the autofill covers it: `autofill_enabled` defaults
 * to true and fills every empty slot at lock, deterministically. So an unset
 * lineup costs a manager nothing unless they turned that off, and alarming about
 * it would be alarming about a thing the product already handles. It fires only
 * when autofill is off, which is the case where it is true.
 */

import type { SqlClient } from "./client.js";
import { buildRosterShape, NFL, pickPosition, rosterOverage } from "@rostr/core";
import type { IrRosterEntry, LeagueRules } from "@rostr/core";

/**
 * What kind of thing is waiting.
 *
 * Ordered by urgency in {@link NOTIFICATION_URGENCY}, which is what decides the
 * single item the strip shows.
 */
export type NotificationKind =
  | "ON_THE_CLOCK"
  | "TRADE_AWAITING_YOU"
  | "VETO_WINDOW"
  | "DRAFT_SOON"
  | "ROSTER_OVER_LIMIT"
  | "LINEUP_UNSET"
  | "PLAYER_OFF_NFL_ROSTER"
  | "INVITATION";

/**
 * Most pressing first.
 *
 * A pick clock runs in seconds and everything else in hours or days, so it
 * outranks the lot. A trade you have not answered outranks a veto window because
 * the trade cannot proceed without you and the veto can.
 *
 * **Ranked by how soon acting stops being possible, and where two items are both
 * open-ended, by what ignoring one costs.** This used to say an invitation is
 * last because "it is the only item with no deadline at all", which was already
 * untrue when it was written — `unsetLineups` returns `deadline: null` too, and
 * ranks above it. The window is what matters, not whether a field holds a date:
 * an unset lineup closes at kickoff whether or not anything stored the hour.
 *
 * So the two open-ended items are separated by cost. A player who is no longer
 * on an NFL roster scores zero every remaining week and nothing in the system
 * corrects it. An invitation costs nothing and expires never, which is what
 * keeps it last.
 */
export const NOTIFICATION_URGENCY: readonly NotificationKind[] = [
  "ON_THE_CLOCK",
  "TRADE_AWAITING_YOU",
  "VETO_WINDOW",
  "DRAFT_SOON",
  // Above an unset lineup because it costs strictly more and closes at least as
  // soon: an unset lineup costs the empty slots and only when autofill is off,
  // while this costs the lineup *and* the autofill *and* every acquisition, and
  // the window shuts at the same kickoff.
  "ROSTER_OVER_LIMIT",
  "LINEUP_UNSET",
  "PLAYER_OFF_NFL_ROSTER",
  "INVITATION",
];

export interface Notification {
  readonly kind: NotificationKind;
  readonly leagueId: string;
  readonly leagueName: string;
  /** Where acting on it happens. */
  readonly href: string;
  /** One line, already written for a person. */
  readonly text: string;
  /**
   * When it stops being actionable, or `null` when nothing expires.
   *
   * The strip renders a countdown from this; the bell shows it as context. An
   * invitation has none, which is why it sorts last.
   */
  readonly deadline: Date | null;
  /**
   * Whether acting will ask for a wallet signature.
   *
   * Drop 9 asks for this: "this will ask for your wallet" belongs before the
   * click, not after it. Joining signs the rules hash; a pick and a vote sign
   * nothing — see `ANSWERS.md`.
   */
  readonly needsSignature: boolean;
}

/**
 * How far ahead a draft counts as imminent.
 *
 * An hour, because that is the window in which a manager can still do something
 * about it — set a queue, find a substitute, be at a keyboard. A day's warning
 * on a hub somebody visits weekly is noise.
 */
const DRAFT_SOON_MS = 60 * 60 * 1000;

/**
 * Players on your roster who are no longer on an NFL roster.
 *
 * `season-sync` clears `players.active` for anyone the provider stops listing
 * with a club, and until now that was the end of it: the player stayed on the
 * roster, scored zero every week, and the only thing on screen was a headshot
 * carrying whatever club the provider last reported. Issue #254. The one place
 * in the product that states this fact — `waiver-run.ts`, "he is no longer on an
 * NFL roster" — says it to a rival whose claim failed, never to the manager
 * holding him.
 *
 * **Derived, like everything else here, and that is what makes it correct.** The
 * fact is a standing one rather than an event: it is true for as long as he is
 * held and not listed, and it stops being true when he is dropped or signs
 * somewhere. A stored notification would have to be written when the flag
 * flipped and deleted when it flipped back, and `syncPlayers` re-asserts
 * `active` unconditionally on every run, so the flag is bidirectional and the
 * copy would be wrong in both directions.
 *
 * **One row per league**, aggregated. `HeaderControls` keys the list on
 * `kind:leagueId`, so a second row for the same league would collide — and a
 * manager holding two cut players has one problem, not two.
 *
 * **It carries a name.** The count alone would be `unsetLineups`' shape, but an
 * empty lineup slot is visible the moment you arrive and this is not: the roster
 * panel renders every player identically, so "1 player" would send somebody to a
 * fourteen-row list with no way to tell which. Naming one and counting the rest
 * is the least this can say and still be actionable.
 *
 * **No advice in the text.** Not "drop him", not "replace him".
 * `waiver-run.ts` set this convention for the identical fact — state what is
 * observable, imply no permanence — and it holds here for two more reasons: a
 * cut player may be signed again on Wednesday, and whether he should be
 * acquirable at all is what issue #276 exists to decide. The link is the advice.
 */
async function playersOffNflRosters(db: SqlClient, userId: string): Promise<Notification[]> {
  const rows = await db.query<{
    league_id: string;
    league_name: string;
    held: number;
    names: string[];
  }>(
    `SELECT l.id AS league_id, l.name AS league_name, count(*)::int AS held,
            array_agg(p.full_name ORDER BY p.full_name) AS names
       FROM league_memberships m
       JOIN leagues l ON l.id = m.league_id
       JOIN teams t ON t.id = m.team_id
       JOIN roster_entries r ON r.team_id = t.id AND r.released_at IS NULL
       JOIN players p ON p.id = r.player_id
      WHERE m.user_id = $1
        AND l.state IN ('IN_SEASON', 'PLAYOFFS')
        AND NOT p.active
      GROUP BY l.id, l.name`,
    [userId],
  );

  return rows.map((row) => {
    const [first] = row.names;
    const others = row.held - 1;

    return {
      kind: "PLAYER_OFF_NFL_ROSTER" as const,
      leagueId: row.league_id,
      leagueName: row.league_name,
      href: `/leagues/${row.league_id}/players`,
      text:
        others === 0
          ? `${first} is no longer on an NFL roster in ${row.league_name} and cannot score`
          : `${first} and ${others} other${others === 1 ? "" : "s"} are no longer on an NFL ` +
            `roster in ${row.league_name} and cannot score`,
      deadline: null,
      needsSignature: false,
    };
  });
}

/**
 * Leagues where this manager's roster is over the limit.
 *
 * The one state a manager can be in without having done anything: a player
 * stashed on injured reserve recovers, the exemption is read live, and the
 * counted size rises on the hourly cron's schedule rather than theirs. Nothing
 * is forced off the roster — but until they release somebody the league stops
 * acting for them, and the autofill in particular stops picking anyone.
 *
 * **Which is why this has to reach them.** The rest of the restriction is
 * discovered the moment they try to do something. The autofill is not: it is a
 * thing that silently does not happen, on a Sunday, to a manager who may not
 * open the app. `RULES.md` §8 says a rule people would only discover by losing
 * money to it is the wrong rule to have, and without this notification that is
 * exactly what this would be.
 *
 * Rules live in a frozen JSON document rather than in columns, and the
 * exemption depends on `isIrEligible` — another company's vocabulary, which
 * changes — so this returns a row per rostered player and does the arithmetic
 * in TypeScript through the same helper every other capacity check uses.
 * Re-expressing that deny-list in SQL would be a second copy of a moving rule.
 * It is the first non-aggregate query in this file; at a dozen or so rows per
 * league that is within the budget the module documents.
 */
async function rostersOverLimit(db: SqlClient, userId: string): Promise<Notification[]> {
  const rows = await db.query<{
    league_id: string;
    league_name: string;
    canonical: string;
    player_id: string;
    on_ir: boolean;
    designation: string | null;
  }>(
    `SELECT l.id AS league_id, l.name AS league_name, lr.canonical,
            r.player_id, r.on_ir, p.injury_designation AS designation
       FROM league_memberships m
       JOIN leagues l ON l.id = m.league_id
       JOIN league_rules lr ON lr.league_id = l.id
       JOIN teams t ON t.id = m.team_id
       JOIN roster_entries r ON r.team_id = t.id AND r.released_at IS NULL
       JOIN players p ON p.id = r.player_id
      WHERE m.user_id = $1
        AND l.state IN ('IN_SEASON', 'PLAYOFFS')`,
    [userId],
  );

  const byLeague = new Map<
    string,
    { name: string; canonical: string; roster: IrRosterEntry[] }
  >();
  for (const row of rows) {
    const found = byLeague.get(row.league_id) ?? {
      name: row.league_name,
      canonical: row.canonical,
      roster: [],
    };
    found.roster.push({
      playerId: row.player_id,
      onIr: row.on_ir,
      injuryDesignation: row.designation,
    });
    byLeague.set(row.league_id, found);
  }

  const items: Notification[] = [];
  for (const [leagueId, league] of byLeague) {
    const rules = JSON.parse(league.canonical) as LeagueRules;
    const shape = buildRosterShape(rules.roster, NFL);
    const overage = rosterOverage({
      roster: league.roster,
      totalSlots: shape.totalSlots,
      irSlots: shape.irSlots,
    });
    if (!overage.over) continue;

    const players = overage.mustRelease === 1 ? "one player" : `${overage.mustRelease} players`;

    items.push({
      kind: "ROSTER_OVER_LIMIT",
      leagueId,
      leagueName: league.name,
      href: `/leagues/${leagueId}/players`,
      text:
        `Your roster in ${league.name} holds ${overage.counted} players and the limit is ` +
        `${overage.limit} — release ${players}. Until then your lineup is frozen and the ` +
        `autofill will not pick anyone for you.`,
      deadline: null,
      needsSignature: false,
    });
  }

  return items;
}

/**
 * Everything waiting on this user, most urgent first.
 *
 * `now` is passed rather than read, so every deadline in the result is measured
 * against one instant and a test can place itself.
 */
export async function notificationsForUser(
  db: SqlClient,
  userId: string,
  now: Date,
): Promise<readonly Notification[]> {
  const [drafts, trades, vetoes, invitations, lineups, cut, overLimit] = await Promise.all([
    draftNotifications(db, userId, now),
    tradesAwaitingYou(db, userId),
    vetoWindows(db, userId, now),
    invitationNotifications(db, userId),
    unsetLineups(db, userId),
    playersOffNflRosters(db, userId),
    rostersOverLimit(db, userId),
  ]);

  const all = [
    ...drafts,
    ...trades,
    ...vetoes,
    ...invitations,
    ...lineups,
    ...cut,
    ...overLimit,
  ];

  return all.sort((a, b) => {
    const byKind = NOTIFICATION_URGENCY.indexOf(a.kind) - NOTIFICATION_URGENCY.indexOf(b.kind);
    if (byKind !== 0) return byKind;

    // Within a kind, the one expiring soonest. A null deadline sorts last —
    // never before something that is actually running out.
    if (a.deadline && b.deadline) return a.deadline.getTime() - b.deadline.getTime();
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return 0;
  });
}

/**
 * Your pick is live, or your draft starts within the hour.
 *
 * **The team on the clock is asked of `pickPosition`**, never worked out here.
 * `drafts` stores no current team — it is derived from the pick number and the
 * drawn order, and a second implementation is the failure this repo names by
 * hand: the first time the two disagreed, a bell would say your pick was live
 * while the draft room disagreed.
 */
async function draftNotifications(
  db: SqlClient,
  userId: string,
  now: Date,
): Promise<Notification[]> {
  const rows = await db.query<{
    league_id: string;
    league_name: string;
    status: string;
    scheduled_at: string;
    pick_seconds: number;
    clock_started_at: string | null;
    draft_position: number | null;
    team_count: number;
    picks_made: number;
  }>(
    `SELECT l.id AS league_id, l.name AS league_name, d.status, d.scheduled_at,
            d.pick_seconds, d.clock_started_at, mt.draft_position,
            (SELECT count(*)::int FROM teams t WHERE t.league_id = l.id) AS team_count,
            (SELECT count(*)::int FROM draft_picks p WHERE p.draft_id = d.id) AS picks_made
       FROM league_memberships m
       JOIN leagues l ON l.id = m.league_id
       JOIN teams mt ON mt.id = m.team_id
       JOIN drafts d ON d.league_id = l.id
      WHERE m.user_id = $1 AND d.status IN ('SCHEDULED', 'IN_PROGRESS')`,
    [userId],
  );

  const out: Notification[] = [];

  for (const row of rows) {
    const teamCount = Number(row.team_count);
    const picksMade = Number(row.picks_made);

    if (row.status === "IN_PROGRESS" && row.draft_position !== null && teamCount > 0) {
      const { orderIndex } = pickPosition(picksMade + 1, teamCount);
      if (orderIndex === Number(row.draft_position) - 1) {
        out.push({
          kind: "ON_THE_CLOCK",
          leagueId: row.league_id,
          leagueName: row.league_name,
          href: `/leagues/${row.league_id}/draft`,
          text: `You are on the clock in ${row.league_name}`,
          // The pick clock, from when it started — the same arithmetic the
          // draft room does, and null if the clock is somehow not running.
          deadline: row.clock_started_at
            ? new Date(new Date(row.clock_started_at).getTime() + row.pick_seconds * 1000)
            : null,
          needsSignature: false,
        });
      }
      continue;
    }

    if (row.status === "SCHEDULED") {
      const startsAt = new Date(row.scheduled_at);
      const until = startsAt.getTime() - now.getTime();
      if (until > 0 && until <= DRAFT_SOON_MS) {
        out.push({
          kind: "DRAFT_SOON",
          leagueId: row.league_id,
          leagueName: row.league_name,
          href: `/leagues/${row.league_id}/lobby`,
          text: `${row.league_name} drafts within the hour`,
          deadline: startsAt,
          needsSignature: false,
        });
      }
    }
  }

  return out;
}

/** A trade proposed to you, which cannot move until you answer. */
async function tradesAwaitingYou(db: SqlClient, userId: string): Promise<Notification[]> {
  const rows = await db.query<{
    league_id: string;
    league_name: string;
    trade_id: string;
  }>(
    `SELECT l.id AS league_id, l.name AS league_name, tr.id AS trade_id
       FROM trades tr
       JOIN league_memberships m
         ON m.team_id = tr.receiver_team_id AND m.league_id = tr.league_id
       JOIN leagues l ON l.id = tr.league_id
      WHERE m.user_id = $1 AND tr.state = 'PROPOSED'`,
    [userId],
  );

  return rows.map((row) => ({
    kind: "TRADE_AWAITING_YOU" as const,
    leagueId: row.league_id,
    leagueName: row.league_name,
    href: `/leagues/${row.league_id}/trades`,
    text: `A trade is waiting on your answer in ${row.league_name}`,
    // A proposal has no deadline of its own — it expires against the trade
    // deadline, which is a week rather than a clock.
    deadline: null,
    needsSignature: false,
  }));
}

/**
 * A trade you can still veto, in a league you are in and not party to.
 *
 * The three conditions are the electorate `RULES.md` §6 defines — in the league,
 * not involved, not a bot — and they are applied here rather than restated,
 * because a numerator and denominator that disagree are what force a veto nobody
 * cast.
 */
async function vetoWindows(db: SqlClient, userId: string, now: Date): Promise<Notification[]> {
  const rows = await db.query<{
    league_id: string;
    league_name: string;
    veto_deadline: string;
  }>(
    `SELECT l.id AS league_id, l.name AS league_name, tr.veto_deadline
       FROM trades tr
       JOIN leagues l ON l.id = tr.league_id
       JOIN league_memberships m ON m.league_id = tr.league_id
      WHERE m.user_id = $1
        AND tr.state = 'ACCEPTED'
        AND tr.veto_deadline IS NOT NULL
        AND tr.veto_deadline > $2
        AND m.team_id <> tr.proposer_team_id
        AND m.team_id <> tr.receiver_team_id
        AND NOT EXISTS (
          SELECT 1 FROM trade_vetoes v
           WHERE v.trade_id = tr.id AND v.team_id = m.team_id
        )`,
    [userId, now.toISOString()],
  );

  return rows.map((row) => ({
    kind: "VETO_WINDOW" as const,
    leagueId: row.league_id,
    leagueName: row.league_name,
    href: `/leagues/${row.league_id}/trades`,
    text: `A trade in ${row.league_name} is in its veto window`,
    deadline: new Date(row.veto_deadline),
    needsSignature: false,
  }));
}

/** Leagues that asked for you and are still open. */
async function invitationNotifications(db: SqlClient, userId: string): Promise<Notification[]> {
  const rows = await db.query<{ league_id: string; league_name: string }>(
    `SELECT l.id AS league_id, l.name AS league_name
       FROM league_invitations i
       JOIN leagues l ON l.id = i.league_id
      WHERE i.invited_user_id = $1
        AND i.withdrawn_at IS NULL
        AND l.state = 'FORMING'
        AND NOT EXISTS (
          SELECT 1 FROM league_memberships m
           WHERE m.league_id = i.league_id AND m.user_id = i.invited_user_id
        )`,
    [userId],
  );

  return rows.map((row) => ({
    kind: "INVITATION" as const,
    leagueId: row.league_id,
    leagueName: row.league_name,
    href: `/leagues/${row.league_id}`,
    text: `You are invited to ${row.league_name}`,
    deadline: null,
    // Joining signs the rules hash. The one item here that does.
    needsSignature: true,
  }));
}

/**
 * An empty starting slot, in a league where nothing will fill it.
 *
 * **Only when autofill is off**, which is the whole of this check. The autofill
 * is on by default and fills empty slots deterministically — so an unset lineup
 * normally costs a manager nothing, and warning about it would be warning about
 * a thing the product already handles. With it off, an empty slot scores zero
 * and the warning is true.
 *
 * **That premise is now conditional and this filter has not caught up.** The
 * autofill will not start a player whose own game has kicked off, so a slot
 * where everyone eligible is already playing is left empty on purpose — on an
 * autofill-*on* team, which this query never looks at. That manager is told
 * nothing, while the slot is still fillable from free agency.
 *
 * The one-line widening is worse than the gap: the join above already selects
 * only `player_id IS NULL` rows, so dropping the autofill predicate warns every
 * team with any empty row — which, before the week's first kickoff, is every
 * autofill-on team every week. Telling the two apart needs a record of what the
 * autofill decided, and nothing stores one. Tracked separately.
 */
async function unsetLineups(db: SqlClient, userId: string): Promise<Notification[]> {
  const rows = await db.query<{
    league_id: string;
    league_name: string;
    empty: number;
  }>(
    `SELECT l.id AS league_id, l.name AS league_name, count(*)::int AS empty
       FROM league_memberships m
       JOIN leagues l ON l.id = m.league_id
       JOIN teams t ON t.id = m.team_id
       JOIN lineups ln ON ln.team_id = t.id AND ln.player_id IS NULL
      WHERE m.user_id = $1
        AND l.state IN ('IN_SEASON', 'PLAYOFFS')
        AND t.autofill_enabled = false
      GROUP BY l.id, l.name`,
    [userId],
  );

  return rows.map((row) => ({
    kind: "LINEUP_UNSET" as const,
    leagueId: row.league_id,
    leagueName: row.league_name,
    href: `/leagues/${row.league_id}/lineup`,
    text: `${row.empty} empty ${Number(row.empty) === 1 ? "slot" : "slots"} in ${row.league_name}, and autofill is off`,
    deadline: null,
    needsSignature: false,
  }));
}
