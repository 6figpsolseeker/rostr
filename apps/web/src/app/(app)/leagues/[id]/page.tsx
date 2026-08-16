import { notFound } from "next/navigation";
import {
  getChainState,
  getLeagueRules,
  memberWallet,
  getOnChainJoin,
  getWallets,
} from "@rostr/db";
import { LeagueChrome } from "@/components/LeagueChrome";
import { RulesView } from "@/components/RulesView";
import { JoinPanel } from "@/components/JoinPanel";
import { AnchorPanel } from "@/components/AnchorPanel";
import { DepositPanel } from "@/components/DepositPanel";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { depositsOpen } from "@/lib/pot";

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
      <LeagueChrome
        leagueId={league.id}
        name={league.name}
        subtitle={`${league.season} season · ${taken}/${stored.rules.league.maxTeams} teams · ${league.state
          .toLowerCase()
          .replace("_", " ")}`}
        rulesHash={stored.hash}
        active=""
      />

      {/*
        The draft and the bracket are not tabs.

        The design's nav is the six screens a manager uses every week. A draft
        happens once and a bracket only exists from Week 15, so putting either in
        the permanent nav would leave a dead link for most of the season. They
        are surfaced from the body instead, when there is something behind them.
      */}
      <div className="flex flex-wrap gap-3">
        <a
          href={`/leagues/${league.id}/draft`}
          className="rounded-[4px] border border-nocturne-neutral-800 px-[14px] py-2 text-[13.5px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
        >
          Draft room
        </a>
        <a
          href={`/leagues/${league.id}/bracket`}
          className="rounded-[4px] border border-nocturne-neutral-800 px-[14px] py-2 text-[13.5px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
        >
          Playoff bracket
        </a>
      </div>

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
        hasPot={stored.rules.pot !== null}
        tokenMint={stored.rules.pot?.tokenMint ?? null}
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

      {/*
        Members only — `memberWallet` is the same derivation `/api/leagues/[id]/
        deposit` enforces server-side, so the screen and the server give one
        answer. A stranger was previously shown a Stake button on a league they
        had not joined.

        Deliberately **not** conditioned on `depositsOpen()`. The panel holds the
        only refund control in the app, and a member who has already staked must
        be able to reach it whether or not new deposits are open. The gate is
        passed down and applied to the stake button alone.
      */}
      {stored.rules.pot && myWallet !== null && (
        <DepositPanel
          leagueId={league.id}
          tokenMint={stored.rules.pot.tokenMint}
          depositsOpen={depositsOpen()}
          refundUnlockAt={stored.rules.pot.refundUnlockAt}
        />
      )}
    </div>
  );
}
