import { notFound } from "next/navigation";
import { getLeagueRules, loadDraft, teamForUser } from "@rostr/db";
import { DraftLobby } from "@/components/DraftLobby";
import { LeagueChrome } from "@/components/LeagueChrome";
import { db } from "@/lib/db";
import { buildLobbyView } from "@/lib/lobby";
import { leagueReadAccess } from "@/lib/visibility";
import { currentUser } from "@/lib/session";

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

  const view = buildLobbyView({
    leagueId: league.id,
    rulesHash: stored.hash,
    minHumans: stored.rules.league.minHumans,
    rounds: draft.rounds,
    scheduledAt: draft.scheduledAt,
    now,
    viewerTeamId: myTeam?.teamId ?? null,
    isCommissioner: user !== null && league.commissioner_id === user.id,
    commissionerTeamId: commissionerTeam?.id ?? null,
    teams: teams.map((team) => ({
      teamId: team.id,
      name: team.name,
      isBot: team.is_bot,
      position: team.draft_position === null ? null : Number(team.draft_position),
    })),
    hasPot: stored.rules.pot !== null,
    unfundedMembers: Number(unfunded?.count ?? 0),
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
        isCommissioner={user !== null && league.commissioner_id === user.id}
        draftStarted={draft.clockStartedAt !== null}
      />
    </div>
  );
}
