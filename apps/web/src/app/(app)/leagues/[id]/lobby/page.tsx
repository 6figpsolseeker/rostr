import { notFound } from "next/navigation";
import {
  getChainState,
  getLeagueRules,
  loadDraft,
  settlementPlan,
  SettlementPlanError,
  teamForUser,
} from "@rostr/db";
import { DraftLobby } from "@/components/DraftLobby";
import { SettlementPanel } from "@/components/SettlementPanel";
import { LeagueChrome } from "@/components/LeagueChrome";
import { db } from "@/lib/db";
import { buildLobbyView } from "@/lib/lobby";
import { leagueReadAccess } from "@/lib/visibility";
import { currentUser } from "@/lib/session";
import { scoresAlreadyWritten } from "@/lib/settlement-preflight";

/**
 * The draft lobby — the screen between a full league and a live draft.
 *
 * It exists because the draw is the product's argument in one moment: an order
 * nobody could have known, from a block nobody chose, checkable by anyone. That
 * needs somewhere to be read. `explainOrderDraw` has been written, tested and
 * exported since the draw shipped and was rendered nowhere, which made the
 * verification real and unperformable at the same time.
 */
export default async function LobbyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = db();

  const [league] = await client.query<{
    id: string;
    name: string;
    season: number;
    state: string;
    commissioner_id: string;
  }>("SELECT id, name, season, state, commissioner_id FROM leagues WHERE id = $1", [id]);
  if (!league) notFound();

  // A private league reports nothing about how it is going to a non-member, and
  // the order draw is very much how it is going. `notFound` rather than a
  // notice: a "this league is private" page confirms the league exists.
  if (!(await leagueReadAccess(id)).ok) notFound();

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const draft = await loadDraft(client, id);
  if (!draft) notFound();

  const user = await currentUser();
  const myTeam = user ? await teamForUser(client, id, user.id) : null;

  // Ordered by the draw once it exists and by join slot before it. Sorting by
  // anything else beforehand would imply an order the whole screen says does
  // not yet exist.
  const teams = await client.query<{
    id: string;
    name: string;
    is_bot: boolean;
    owner_id: string | null;
    draft_position: number | null;
  }>(
    `SELECT id, name, is_bot, owner_id, draft_position
       FROM teams
      WHERE league_id = $1
      ORDER BY ${draft.draw ? "draft_position" : "slot"}`,
    [id],
  );

  const commissionerTeam = teams.find((team) => team.owner_id === league.commissioner_id);
  const now = new Date();

  /*
    Members of a pot league whose stake is not in the vault.

    The same query `drawDraftOrder` refuses on, so the lobby cannot promise a
    draw the server will decline — `refunded_at IS NULL` included, because a
    member who staked and then withdrew under a failed league's refund has their
    money back and is not funded.

    A count, not a list. Naming who has not paid turns a scheduling problem into
    a public accusation on a screen the whole league can see.
  */
  const [unfunded] = stored.rules.pot
    ? await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM teams t
           JOIN league_memberships m ON m.team_id = t.id
           JOIN wallets w ON w.id = m.wallet_id
           LEFT JOIN league_onchain_stakes s
             ON s.league_id = t.league_id AND s.wallet_address = w.address
          WHERE t.league_id = $1
            AND t.is_bot = false
            AND (s.deposited_at IS NULL OR s.refunded_at IS NOT NULL)`,
        [id],
      )
    : [{ count: 0 }];

  /*
    Whether the chain has been told this season is starting.

    Recorded only after `/start-season` read `League.started` back off the
    account, and it is what `drawDraftOrder` refuses a pot league without — so
    reading the same row here is what stops the lobby offering a draw the server
    will decline. Free leagues never have it and never need it.
  */
  const chain = await getChainState(client, id);

  /*
    The settlement account, which the draw refuses to draw without.

    Shown to the commissioner only while it is missing, and only for a pot
    league — a free league has nothing to settle and `initialize_scores` refuses
    it outright. Reading the chain here rather than in the component keeps the
    decision on the server, where the draw's own gate lives; the panel's job is
    the signature.

    A failure to build the plan is not a failure to render the lobby. Every
    reason it can refuse — no wallet on a team, no pot — is something the
    commissioner needs to see explained rather than as a blank page, and the draw
    will refuse them for the same reason with a better message. So it degrades to
    "no panel" and the draw does the talking.
  */
  const isCommissioner = user !== null && league.commissioner_id === user.id;
  let settlement: Awaited<ReturnType<typeof settlementPlan>> | null = null;
  if (isCommissioner && stored.rules.pot && !draft.draw) {
    try {
      const onChain = await scoresAlreadyWritten(id);
      if (!onChain) settlement = await settlementPlan(client, id);
    } catch (error) {
      if (!(error instanceof SettlementPlanError)) throw error;
    }
  }

  const view = buildLobbyView({
    leagueId: league.id,
    rulesHash: stored.hash,
    minHumans: stored.rules.league.minHumans,
    rounds: draft.rounds,
    scheduledAt: draft.scheduledAt,
    now,
    viewerTeamId: myTeam?.teamId ?? null,
    isCommissioner,
    commissionerTeamId: commissionerTeam?.id ?? null,
    teams: teams.map((team) => ({
      teamId: team.id,
      name: team.name,
      isBot: team.is_bot,
      position: team.draft_position === null ? null : Number(team.draft_position),
    })),
    hasPot: stored.rules.pot !== null,
    unfundedMembers: Number(unfunded?.count ?? 0),
    seasonStarted: chain?.seasonStartedAt != null,
    draw: draft.draw
      ? {
          slot: draft.draw.slot,
          blockhash: draft.draw.blockhash,
          seed: draft.draw.seed,
          drawnAt: draft.draw.drawnAt,
        }
      : null,
  });

  return (
    <div className="space-y-10">
      <LeagueChrome
        leagueId={league.id}
        name={league.name}
        subtitle={
          view.phase === "DRAWN"
            ? `Draft lobby · order drawn · field locked`
            : `Draft lobby · ${view.humans} of ${teams.length} seats taken by managers`
        }
        rulesHash={stored.hash}
        // This page already `notFound()`s a non-member above, so anyone who
        // renders it can reach every tab.
        navOpen
        active=""
      />

      {settlement && (
        <SettlementPanel
          leagueId={league.id}
          roster={settlement.roster.map((entry) => ({ ...entry }))}
          oracle={settlement.oracle}
          tiebreakers={settlement.tiebreakers}
          playoffWeeks={settlement.playoffWeeks}
          regularSeasonWeeks={settlement.regularSeasonWeeks}
          playoffTeams={settlement.playoffTeams}
          firstRoundByes={settlement.firstRoundByes}
          thirdPlace={settlement.thirdPlace}
        />
      )}

      <DraftLobby
        leagueId={league.id}
        phase={view.phase}
        scheduledAt={view.scheduledAt.toISOString()}
        serverNow={view.now.toISOString()}
        seats={view.seats}
        humans={view.humans}
        bots={view.seats.length - view.humans}
        minHumans={view.minHumans}
        pickSeconds={draft.pickSeconds}
        rounds={draft.rounds}
        drawBlocker={view.drawBlocker}
        readiness={view.readiness}
        // Instants cross into the client as ISO strings here, the same way
        // `scheduledAt` and `serverNow` do — one convention rather than two.
        seasonStart={
          view.seasonStart.state === "OPEN"
            ? {
                state: "OPEN",
                closesAt: view.seasonStart.closesAt.toISOString(),
                blockedBy: view.seasonStart.blockedBy,
              }
            : view.seasonStart.state === "MISSED"
              ? { state: "MISSED", closedAt: view.seasonStart.closedAt.toISOString() }
              : { state: view.seasonStart.state }
        }
        verification={
          view.verification
            ? {
                slot: view.verification.slot,
                blockhash: view.verification.blockhash,
                seed: view.verification.seed,
                drawnAt: view.verification.drawnAt.toISOString(),
                explanation: view.verification.explanation,
              }
            : null
        }
        yourPicks={view.yourPicks}
        isCommissioner={isCommissioner}
        draftStarted={draft.clockStartedAt !== null}
      />
    </div>
  );
}
