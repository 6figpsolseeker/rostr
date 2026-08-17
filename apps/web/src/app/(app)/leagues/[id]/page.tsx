import { notFound } from "next/navigation";
import {
  getChainState,
  getLeagueRules,
  memberWallet,
  getOnChainJoin,
  getWallets,
} from "@rostr/db";
import { LeagueChrome } from "@/components/LeagueChrome";
import { leagueNavOpen } from "@/lib/visibility";
import { RulesView } from "@/components/RulesView";
import { JoinPanel } from "@/components/JoinPanel";
import { AnchorPanel } from "@/components/AnchorPanel";
import { DepositPanel } from "@/components/DepositPanel";
import { CommissionerSetup } from "@/components/CommissionerSetup";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { depositsOpen } from "@/lib/pot";
import { commissionerSetup } from "@/lib/setup";

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

  const anchored = chain?.anchoredAt !== null && chain?.anchoredAt !== undefined;
  const isCommissioner = user !== null && commissioner?.commissioner_id === user.id;

  /*
    What the commissioner still owes their own league (#165).

    Every input is already loaded above, and every one of them is a row rather
    than a step counter — which is the point. The four steps each involve a
    wallet popup, so leaving the page part-way through is the ordinary case, and
    a position held in a component's state would be lost exactly when it was
    needed. Resolved here, it survives a reload and a second tab.

    `memberWallet` is the membership row and the team is written in the same
    transaction, so it answers "has a seat"; `resumable` is already "has a seat
    and no on-chain record", which is the fourth step still owed.

    The last three are what stop the list naming a step that can never be taken.
    `leagueState` and `seatsFree` are the same two facts `open` below is built
    from, and `fieldLocked` is the frozen draft time against the server's clock —
    the instant migration `0028` starts refusing every `teams` INSERT. Nothing in
    this app moves a league out of FORMING when that time passes, so without them
    the checklist would go on asking for a seat forever.
  */
  const setup = commissionerSetup({
    isCommissioner,
    hasLinkedWallet: wallets.length > 0,
    anchored,
    hasTeam: myWallet !== null,
    onChainJoined: myWallet !== null && !resumable,
    leagueState: league.state,
    seatsFree: taken < stored.rules.league.maxTeams,
    fieldLocked: Date.now() >= stored.rules.draft.scheduledAt * 1000,
  });

  // Whether the six tabs and the two buttons below lead anywhere for this
  // viewer. Derived from the same gate those destinations enforce, so the nav
  // and the 404 cannot disagree — see `leagueNavOpen`.
  const navOpen = await leagueNavOpen(id);

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
        navOpen={navOpen}
      />

      {/*
        First on the page, and only while something is owed.

        A commissioner who has not finished is the person least able to guess
        what to do next: their league is real, its rules are frozen, and every
        tab 404s at them because they are not a member of it. Once the four
        steps are done `setup.complete` is true and this disappears — a
        permanently all-ticked list is noise on a screen people open weekly.

        It stays when the steps can no longer be taken, and says so instead. A
        commissioner who never joined their own league is not less entitled to
        be told once it is too late to fix.
      */}
      {setup && !setup.complete ? (
        <CommissionerSetup
          setup={setup}
          fieldLocksAt={new Date(stored.rules.draft.scheduledAt * 1000)}
        />
      ) : null}

      {/*
        The draft and the bracket are not tabs.

        The design's nav is the six screens a manager uses every week. A draft
        happens once and a bracket only exists from Week 15, so putting either in
        the permanent nav would leave a dead link for most of the season. They
        are surfaced from the body instead, when there is something behind them.
      */}
      {/*
        Gated on the same boolean as the tabs. These two 404 on exactly the same
        check, so hiding the nav and leaving them would be half a fix — the
        commissioner would still hit a dead end from the same screen.
      */}
      {navOpen ? (
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
      ) : null}

      {/*
        The rules render above the join control, always, and in full. A join
        button placed before the rules would make "shown before you join" a
        technicality rather than a fact.
      */}
      <RulesView rules={stored.rules} hash={stored.hash} />

      {/*
        Only the commissioner, and only while it is unanchored. Anchoring is
        signed by their own wallet, so this is the one place the flow needs a
        human rather than a job.

        **Above `JoinPanel`, so the screen order is the flow order.** It used to
        sit below, which put the one control the commissioner can act on
        underneath a panel telling them nobody can join yet — including the
        notice explaining that anchoring is theirs to do, with the button for it
        further down the page. It never renders once anchored, so this reorder
        changes nothing for anybody else.
      */}
      {!anchored && isCommissioner && (
        <AnchorPanel
          leagueId={league.id}
          rulesHash={stored.hash}
          maxTeams={stored.rules.league.maxTeams}
          draftScheduledAt={stored.rules.draft.scheduledAt}
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

      <JoinPanel
        leagueId={league.id}
        leagueName={league.name}
        rulesHash={stored.hash}
        open={league.state === "FORMING" && taken < stored.rules.league.maxTeams}
        signedIn={user !== null}
        linkedWallets={wallets.map((wallet) => wallet.address)}
        anchored={anchored}
        isCommissioner={isCommissioner}
        hasPot={stored.rules.pot !== null}
        tokenMint={stored.rules.pot?.tokenMint ?? null}
        resumable={resumable}
      />

      {league.rules_uri && (
        <p className="text-xs text-nocturne-neutral-600">
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
