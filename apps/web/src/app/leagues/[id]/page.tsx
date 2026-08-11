import { notFound } from "next/navigation";
import {
  getChainState,
  getLeagueRules,
  memberWallet,
  getOnChainJoin,
  getWallets,
} from "@rostr/db";
import { RulesView } from "@/components/RulesView";
import { JoinPanel } from "@/components/JoinPanel";
import { AnchorPanel } from "@/components/AnchorPanel";
import { DepositPanel } from "@/components/DepositPanel";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

export default async function LeaguePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = db();

  const [league] = await client.query<{
    id: string;
    name: string;
    season: number;
    state: string;
    rules_hash: string;
    rules_uri: string | null;
  }>("SELECT id, name, season, state, rules_hash, rules_uri FROM leagues WHERE id = $1", [id]);

  if (!league) notFound();

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const [teams] = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM teams WHERE league_id = $1",
    [id],
  );
  const taken = Number(teams?.count ?? 0);

  // Resolved server-side so the panel opens on the right step rather than
  // flashing "sign in" at someone who already is.
  const user = await currentUser();
  const wallets = user ? await getWallets(client, user.id) : [];

  const chain = await getChainState(client, id);
  const [commissioner] = await client.query<{ commissioner_id: string }>(
    "SELECT commissioner_id FROM leagues WHERE id = $1",
    [id],
  );

  // Has this user joined in Postgres but not yet on-chain? Resolved here rather
  // than in the panel's own state, because the two halves are separate
  // transactions with a wallet popup between them — a reload in that gap would
  // otherwise leave a member with no control that reaches the second half.
  const myWallet = user ? await memberWallet(client, id, user.id) : null;
  const resumable = myWallet !== null && (await getOnChainJoin(client, id, myWallet)) === null;

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{league.name}</h1>
        <p className="text-sm text-white/60">
          {league.season} season · {taken}/{stored.rules.league.maxTeams} teams ·{" "}
          {league.state.toLowerCase()}
        </p>
        <div className="flex gap-4">
          <a
            href={`/leagues/${league.id}/matchup`}
            className="text-sm text-[--color-turf] hover:underline"
          >
            Scoreboard →
          </a>
          <a
            href={`/leagues/${league.id}/draft`}
            className="text-sm text-[--color-turf] hover:underline"
          >
            Draft room →
          </a>
          <a
            href={`/leagues/${league.id}/lineup`}
            className="text-sm text-[--color-turf] hover:underline"
          >
            Set lineup →
          </a>
          <a
            href={`/leagues/${league.id}/players`}
            className="text-sm text-[--color-turf] hover:underline"
          >
            Players →
          </a>
          <a
            href={`/leagues/${league.id}/trades`}
            className="text-sm text-[--color-turf] hover:underline"
          >
            Trades →
          </a>
          <a
            href={`/leagues/${league.id}/standings`}
            className="text-sm text-[--color-turf] hover:underline"
          >
            Standings →
          </a>
          <a
            href={`/leagues/${league.id}/bracket`}
            className="text-sm text-[--color-turf] hover:underline"
          >
            Bracket →
          </a>
        </div>
      </header>

      {/*
        The rules render above the join control, always, and in full. A join
        button placed before the rules would make "shown before you join" a
        technicality rather than a fact.
      */}
      <RulesView rules={stored.rules} hash={stored.hash} />

      <JoinPanel
        leagueId={league.id}
        leagueName={league.name}
        rulesHash={stored.hash}
        open={league.state === "FORMING" && taken < stored.rules.league.maxTeams}
        signedIn={user !== null}
        linkedWallets={wallets.map((wallet) => wallet.address)}
        anchored={chain?.anchoredAt !== null && chain?.anchoredAt !== undefined}
        isCommissioner={user !== null && commissioner?.commissioner_id === user.id}
        resumable={resumable}
      />

      {/*
        Only the commissioner, and only while it is unanchored. Anchoring is
        signed by their own wallet, so this is the one place the flow needs a
        human rather than a job — and until it happens nobody can join, which is
        why it sits directly under the notice explaining that.
      */}
      {!chain?.anchoredAt && user !== null && commissioner?.commissioner_id === user.id && (
        <AnchorPanel
          leagueId={league.id}
          rulesHash={stored.hash}
          maxTeams={stored.rules.league.maxTeams}
          pot={
            stored.rules.pot
              ? {
                  tokenMint: stored.rules.pot.tokenMint,
                  buyInBaseUnits: stored.rules.pot.buyInBaseUnits,
                  refundUnlockAt: stored.rules.pot.refundUnlockAt,
                  payout: stored.rules.pot.payout.map((share) => ({
                    prize: share.prize,
                    basisPoints: share.basisPoints,
                  })),
                  feeBps: stored.rules.pot.feeBps,
                  feeRecipient: stored.rules.pot.feeRecipient,
                }
              : null
          }
        />
      )}

      {league.rules_uri && (
        <p className="text-xs text-white/40">
          Rule document: <span className="font-mono break-all">{league.rules_uri}</span>
        </p>
      )}

      {stored.rules.pot && (
        <DepositPanel
          leagueId={league.id}
          tokenMint={stored.rules.pot.tokenMint}
          hasPot={stored.rules.pot !== null}
          refundUnlockAt={stored.rules.pot.refundUnlockAt}
        />
      )}
    </div>
  );
}
