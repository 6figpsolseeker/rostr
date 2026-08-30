import { NextResponse } from "next/server";
import {
  buildNflPprRules,
  CanonicalEncodingError,
  draftDateProblem,
  NFL,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
  NFL_WINNER_TAKE_ALL_PAYOUT,
  validateLeagueRules,
} from "@rostr/core";
import type { PotRules } from "@rostr/core";
import { createDraftRecord, createLeague, LeagueValidationError, seedSport } from "@rostr/db";
import type { CreatedLeague } from "@rostr/db";
import { POT_LEAGUES_COMING_SOON, potLeagueGate, potMintFor } from "@rostr/escrow";
import { db } from "@/lib/db";
import { publishLeagueRules } from "@/lib/pinning";
import { declaredCluster } from "@/lib/cluster";
import { currentUser } from "@/lib/session";

/**
 * How far ahead a draft may be scheduled.
 *
 * 300 days rather than a round year, so the resulting maximum stays provably
 * below the program own horizon: the refund ceiling is at most draft + 365
 * days, and the program refuses anything past now + 730 days at
 * initialize_league. 300 + 365 = 665 leaves 65 days of margin, and a rejection
 * on-chain cannot be retried.
 */
const MAX_DRAFT_LEAD_MS = 300 * 24 * 60 * 60 * 1000;

/**
 * Public leagues you could join.
 *
 * The list behind **Join a league**. Only PUBLIC and only FORMING, which is
 * not a filter so much as the definition: a private league is reachable by
 * invitation or by its link and must never appear in a directory, and a league
 * that has drafted cannot take anyone new — migration `0028` locks the field
 * at the draft time, so offering one would be offering a door that is already
 * shut.
 *
 * **Ungated, deliberately.** `CLAUDE.md`: "PUBLIC leagues are not gated at
 * all — being findable is what public means." This route already published
 * their ids; what is added here is the handful of facts somebody needs to
 * choose between them, all of which are on the league page anyway.
 */
export async function GET(): Promise<NextResponse> {
  const rows = await db().query<{
    id: string;
    name: string;
    season: number;
    state: string;
    team_count: number;
    max_teams: number | null;
    /** Unix **seconds**, as `DraftRules.scheduledAt` stores it. */
    scheduled_at: string | number | null;
    buy_in: string | null;
  }>(
    `SELECT l.id, l.name, l.season, l.state,
            (SELECT count(*)::int FROM teams t WHERE t.league_id = l.id) AS team_count,
            -- Size, draft time and buy-in come from the frozen rule document
            -- rather than from a column, because that document is what a member
            -- signs. A denormalised copy that drifted would advertise a league
            -- on terms nobody agreed to.
            (r.rule_json -> 'league' ->> 'maxTeams')::int AS max_teams,
            (r.rule_json -> 'draft' ->> 'scheduledAt')::bigint AS scheduled_at,
            (r.rule_json -> 'pot' ->> 'buyInBaseUnits') AS buy_in
       FROM leagues l
       LEFT JOIN league_rules r ON r.league_id = l.id
      WHERE l.visibility = 'PUBLIC' AND l.state = 'FORMING'
      ORDER BY l.created_at DESC
      LIMIT 50`,
  );

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      season: r.season,
      state: r.state,
      teamCount: Number(r.team_count),
      maxTeams: r.max_teams === null ? null : Number(r.max_teams),
      /**
       * Unix seconds, passed through as the rules store them.
       *
       * Not converted to an ISO string here: the screen renders it against the
       * reader's own clock, and a server-rendered date would show the server's
       * timezone to somebody in a different one.
       */
      scheduledAt: r.scheduled_at === null ? null : Number(r.scheduled_at),
      /**
       * Base units as a decimal string, or null for a free league.
       *
       * A string all the way to the screen — invariant 2. Parsing it into a
       * number here would be the one place a buy-in could round.
       */
      buyIn: r.buy_in,
    })),
  );
}
interface CreateBody {
  name?: string;
  visibility?: "PRIVATE" | "PUBLIC";
  seasonYear?: number;
  draftMode?: "FAST" | "SLOW";
  pickSeconds?: number;
  draftAt?: number;
  tradeDeadlineWeek?: number;
  pot?: {
    /**
     * Deliberately absent: the token. It comes from `POT_MINTS` on the server,
     * for the same reason `feeRecipient` does — see where it is derived below.
     * Declaring it here and ignoring it would invite someone to start reading
     * it again.
     */
    buyInBaseUnits: string;
    refundUnlockAt: number;
    /** Which prize shape. Anything else, including absent, is the split. */
    payout?: "SPLIT" | "WINNER_TAKE_ALL";
  } | null;
}

export async function POST(request: Request): Promise<NextResponse> {
  // From the session. This route used to accept a `commissionerId` the client
  // supplied, which meant anyone could create a league attributed to anyone —
  // and the commissioner is the only account that can start a draft.
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to create a league" }, { status: 401 });
  }

  /**
   * A username is required, decided by the owner on 2026-08-21.
   *
   * It is what a commissioner types to invite you, so an account without one
   * cannot be reached by either of the two ways of asking — and running a
   * league without being reachable is how somebody ends up alone in one.
   *
   * **This is the enforcement `lib/account.ts` said did not exist.** The gate
   * reported and refused nothing; it now refuses here, at the two points where
   * being unreachable actually costs something. `422` rather than `403`: the
   * request is well-formed and the account is simply unfinished, and the code
   * tells the client where to send them.
   */
  // Total, for the reason `accountGaps` records: an omitted column reads as
  // `undefined` and would throw here rather than refuse.
  if (typeof user.username !== "string" || user.username.trim() === "") {
    return NextResponse.json(
      {
        error: "Pick a username first — it is how people invite you.",
        code: "USERNAME_REQUIRED",
      },
      { status: 422 },
    );
  }

  const body = (await request.json()) as CreateBody;

  if (!body.name || !body.draftAt) {
    return NextResponse.json({ error: "name and draftAt are required" }, { status: 400 });
  }

  // A draft in the past can never draw an order: the deciding block would
  // already exist, which is the whole thing the timing prevents.
  if (body.draftAt * 1000 <= Date.now()) {
    return NextResponse.json(
      { error: "The draft must be scheduled in the future" },
      { status: 400 },
    );
  }

  // And not arbitrarily far into it, which is load-bearing rather than tidy.
  //
  // `pot.refundUnlockAt`'s ceiling is measured from the draft, so an unbounded
  // draft date carries the ceiling with it: a draft in 2100 puts the whole legal
  // refund window in 2100, and a rule set naming a date inside it validates
  // clean. Members would join and stake now against an escape hatch that opens
  // in seventy years.
  //
  // Without this the only thing catching that league is the program's own
  // horizon at `initialize_league` — which refuses it, but *fatally*: the rules
  // are already frozen and the PDA derives from the league's UUID, so it can
  // never be anchored and therefore never joined, only recreated under a new id.
  // This turns an unrecoverable failure at anchor time into a 400 before
  // anything is written.
  //
  // Here rather than in `validateDraft` for the same reason the past check is:
  // it depends on the clock, and re-validating a stored rule set must not become
  // non-deterministic.
  if (body.draftAt * 1000 > Date.now() + MAX_DRAFT_LEAD_MS) {
    return NextResponse.json(
      {
        error:
          "The draft must be scheduled within a year: a league's refund unlock is bounded " +
          "relative to its draft, so a draft far in the future would let the pot be locked " +
          "for just as long.",
      },
      { status: 400 },
    );
  }

  // The fee and its recipient come from server configuration, never from the
  // request. A client-supplied fee would let anyone create a league that pays
  // nothing, and a client-supplied recipient would let them redirect ours.
  //
  // Without FEE_RECIPIENT set there is nowhere to pay, so leagues are created
  // fee-free. That is fine locally and wrong in production, where it would mean
  // silently giving away the fee on every league ever created — the rules are
  // frozen, so it could never be corrected afterwards. Same reasoning as the
  // sign-in link: fail loudly rather than pretend.
  /*
    Pot leagues are closed for the season — see `potLeagueGate`.

    First, and ahead of the three configuration guards below, because it is not
    one: those say "this deployment cannot safely create a pot league yet" and
    invite the operator to fix their environment. This says the product does not
    offer one. Reporting a missing FEE_RECIPIENT to somebody who is never going
    to be allowed a pot either way sends them to configure something irrelevant.

    Enforced here and not only in the form, for the reason `league-read.test.ts`
    is named after: a control that is merely absent from a screen is enforced by
    nothing, and this route is reachable with curl.

    It is deliberately *not* in `validateLeagueRules`. That function is a pure
    function of the frozen document, and a rule set that was valid when it was
    signed must stay valid forever — otherwise the pot leagues already drafted
    on devnet would stop verifying. The door closes in front of creation and
    touches nothing already stored.
  */
  const potGate = potLeagueGate();
  if (body.pot && !potGate.open) {
    return NextResponse.json({ error: POT_LEAGUES_COMING_SOON }, { status: 503 });
  }

  const feeRecipient = process.env.FEE_RECIPIENT ?? "";
  if (body.pot && !feeRecipient && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Pot leagues are unavailable: FEE_RECIPIENT is not configured" },
      { status: 503 },
    );
  }

  /*
    And the settlement oracle, from configuration for the same reason and with a
    stronger case: the fee recipient decides where 1% goes, this decides who may
    post the scores that decide where 100% goes. A client that could name it
    would name its own key and take the pot.

    **Required outright rather than defaulted to empty**, unlike the fee. A
    fee-free league is a real league; a pot with nobody permitted to post its
    scores can never settle at all, and its members would be waiting on the
    timelock refund months later with no way to correct it. Refusing to create
    the league is the only recoverable answer — everything after creation is
    frozen.

    Refused in every environment, not only production. A locally-created pot
    league that could never settle is a league somebody will eventually try to
    settle, and the failure would surface in January rather than now.
  */
  const settlementOracle = process.env.SETTLEMENT_ORACLE ?? "";
  if (body.pot && !settlementOracle) {
    return NextResponse.json(
      {
        error:
          "Pot leagues are unavailable: SETTLEMENT_ORACLE is not configured, so no " +
          "league created now could ever have its scores posted. See docs/SETUP-REQUIRED.md.",
      },
      { status: 503 },
    );
  }

  // **And the token, for the same reason, which was the one that got missed.**
  // The fee recipient decides where 1% goes; the mint decides what the money
  // *is*, and it used to arrive in the request body and go into the frozen
  // rules unread — `validateLeagueRules` asked only that the string was not
  // empty. A crafted POST could denominate a league in any six-decimal token,
  // including one the caller minted and holds the freeze authority for, which
  // would let them freeze the vault and hold every stake to ransom.
  //
  // Deriving it here removes the only write an attacker had into the signed
  // document, and everything downstream is already checked against that
  // document: the anchor route refuses a chain account whose terms differ, and
  // the deposit path builds the member's token account from the *signed* mint,
  // so the program's own `member_token_account.mint == league.token_mint`
  // rejects anything else. The gap was never the checking, it was that the
  // thing being checked against came from the caller.
  //
  // A cluster with no mint refuses rather than falling back — no mint is a
  // reason not to take money, not a reason to accept whatever was offered.
  const potMint = potMintFor(declaredCluster(), process.env.POT_MINT_LOCALNET);
  if (body.pot && !potMint) {
    return NextResponse.json(
      {
        error:
          `Pot leagues are unavailable on ${declaredCluster()}: no pot token is ` +
          `configured for this cluster`,
      },
      { status: 503 },
    );
  }

  // An unrecognised shape is refused rather than quietly treated as the split.
  // The whole creation promise is that the previewed hash is the frozen hash, so
  // a client sending a shape this server does not know about must fail loudly —
  // otherwise the two disagree with nothing to show for it.
  if (
    body.pot &&
    body.pot.payout !== undefined &&
    body.pot.payout !== "SPLIT" &&
    body.pot.payout !== "WINNER_TAKE_ALL"
  ) {
    return NextResponse.json(
      { error: `Unknown payout shape: ${String(body.pot.payout)}` },
      { status: 400 },
    );
  }

  // The draft time is when the field locks, so a league created to draft in the
  // past would refuse its own first join — the commissioner's included — and
  // rules are immutable, so it could never be corrected, only recreated under a
  // new id. `validateLeagueRules` cannot check this: it must stay a pure function
  // of the frozen document so a league can be re-validated years later.
  const draftProblem = draftDateProblem(body.draftAt, new Date());
  if (draftProblem) {
    return NextResponse.json({ error: draftProblem }, { status: 400 });
  }

  const pot: PotRules | null = body.pot
    ? {
        // `potMint` is non-null here: the guard above returned 503 otherwise.
        tokenMint: potMint!,
        buyInBaseUnits: body.pot.buyInBaseUnits,
        // The commissioner picks the shape of the prize at creation, and it is
        // frozen with everything else. Both presets are decidable in a league of
        // any size, which the old five-way split was not — see NFL_DEFAULT_PAYOUT.
        payout:
          body.pot.payout === "WINNER_TAKE_ALL"
            ? NFL_WINNER_TAKE_ALL_PAYOUT
            : NFL_DEFAULT_PAYOUT,
        refundUnlockAt: body.pot.refundUnlockAt,
        feeBps: feeRecipient ? NFL_DEFAULT_FEE_BPS : 0,
        feeRecipient,
        // Non-empty here: the guard above returned 503 otherwise.
        settlementOracle,
      }
    : null;

  const rules = buildNflPprRules({
    seasonYear: body.seasonYear ?? 2026,
    draft: {
      type: "SNAKE",
      mode: body.draftMode ?? "SLOW",
      pickSeconds: body.pickSeconds ?? 14_400,
      scheduledAt: body.draftAt,
    },
    league: { visibility: body.visibility ?? "PRIVATE" },
    ...(body.tradeDeadlineWeek === undefined
      ? {}
      : { trades: { deadlineWeek: body.tradeDeadlineWeek } }),
    pot,
  });

  // Belt and braces: validateLeagueRules already bounds the deadline to the
  // regular season and to week 1, and createLeague refuses rules that do not
  // validate. Checking here only turns a 500-shaped failure into a 400 with a
  // message, since this is the one rule field a client supplies directly.
  const problems = validateLeagueRules(rules, NFL);
  if (problems.length > 0) {
    return NextResponse.json({ error: "Those rules are not valid", problems }, { status: 400 });
  }

  const pool = db();
  const { client, release } = await pool.connect();

  /*
    Assigned inside the block below and read after it, because the publish must
    not run while a connection is checked out. Every path out of the `catch`
    either returns or rethrows, so by the time this is read it is set.
  */
  let created: CreatedLeague;

  try {
    // Idempotent, and cheap. Guarantees the registry exists before the first
    // league on a fresh database.
    await seedSport(client, NFL);

    const league = await createLeague(client, NFL, {
      name: body.name,
      commissionerId: user.id,
      rules,
    });

    // Scheduled here rather than as a separate step. A league whose draft has
    // to be created later is a league that silently has no draft until somebody
    // remembers — and `scheduledAt` is already frozen in the rules, so there is
    // nothing left to decide.
    //
    // No order is drawn: teams are still joining, and a seed that exists while
    // the field can change is a seed a commissioner can grind against.
    await createDraftRecord(client, {
      leagueId: league.id,
      rounds:
        rules.roster.starters.reduce((total, slot) => total + slot.count, 0) +
        rules.roster.benchSlots,
      pickSeconds: rules.draft.pickSeconds,
      scheduledAt: new Date(rules.draft.scheduledAt * 1000),
    });

    // The rule document is published after the connection goes back to the
    // pool — see below the `finally`.
    created = league;
  } catch (error) {
    if (error instanceof LeagueValidationError) {
      return NextResponse.json(
        { error: error.message, problems: error.problems },
        { status: 400 },
      );
    }
    // The encoder is the last word on what may be frozen, and it is stricter
    // than validation: `canonicalize` rejects every non-integer, while
    // `validateLeagueRules` integer-checks the scoring numbers and not much
    // else. This is reachable from here today — `seasonYear`, `draftAt`,
    // `tradeDeadlineWeek` and `pot.refundUnlockAt` all come off the request as
    // numbers and none is integer-checked, so `{ "seasonYear": 2026.5 }` used
    // to escape as an unhandled 500. It is a client error and gets the same
    // 400-with-problems shape as any other bad rule set. Nothing is written:
    // `createLeague` encodes before it opens its transaction.
    if (error instanceof CanonicalEncodingError) {
      return NextResponse.json(
        { error: "Those rules cannot be frozen", problems: [error.message] },
        { status: 400 },
      );
    }
    throw error;
  } finally {
    // Before the pin, deliberately. See below.
    release();
  }

  /*
    Publish the rule document, and never lose the league over it.

    **On the pool, after the connection is released.** Pinning is two network
    round trips behind a 15-second bound, and `pool.connect()` waits when every
    connection is busy — with a 10-second `connectionTimeoutMillis`. Holding one
    across the pin would let a slow pinning service time out *other people's*
    requests, which is the same shape as the rule this repo already states about
    row locks and RPC round trips. Nothing here needs a transaction: it is one
    guarded UPDATE.

    Nothing rolls back on failure, and that is forced rather than chosen —
    `league_rules` refuses its own DELETE and holds the row via ON DELETE
    RESTRICT, so once `createLeague` commits the league is permanent. There is no
    branch in which a failed pin undoes anything; the only choice is what to tell
    the caller.

    An unpublished league is a real, usable state: the rules are frozen, hashed,
    rendered in full above the join control, and anchored on-chain. Publication
    makes them independently verifiable rather than making them exist, and a
    member may join without it — decided by the owner on 2026-08-30.

    After the draft record, because that is the piece a league cannot do without:
    a league with no draft silently has no draft until somebody notices, while a
    league with no URI is listed by `leagues_unpinned_idx`.
  */
  const publication = await publishLeagueRules(pool, created.id, rules);
  if (!publication.published) {
    // The operator's problem, not the commissioner's — a missing key or an
    // outage, neither of which they can act on.
    console.warn(`League ${created.id}: rules not published — ${publication.reason}`);
  }

  return NextResponse.json(
    {
      ...created,
      // Stated rather than implied. A client that assumed publication would have
      // no way to tell this case from a pinned one, and the difference is whether
      // anybody outside this database can check the rules.
      rulesUri: publication.published ? publication.uri : null,
      rulesPublished: publication.published,
    },
    { status: 201 },
  );
}
