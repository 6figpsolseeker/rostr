//! Scores, and who they belong to. G7.
//!
//! `derive.rs` and `bracket.rs` can work out who won given a roster and a list
//! of games. This is where those two things live, and it is the only account in
//! the program that anything writes to after creation.
//!
//! `docs/SETTLEMENT.md` is the design. The three ideas that decide the shape:
//!
//! ## 1. The roster is the payee list, and it is fixed before the season
//!
//! Nothing on-chain otherwise connects a team to a wallet — `Membership` knows a
//! wallet and a stake, and a team is a Postgres fact. Somebody has to attest the
//! pairing, and the only real question is **when**, because an attestation made
//! at payout time cannot be checked by anyone before the money is gone.
//!
//! So it is made here, before a single game is posted, and it is write-once.
//! Every member can check their own row for the whole season; if it is wrong,
//! nobody calls `start_season` and every stake is refundable 48 hours after the
//! draft.
//!
//! **And the wallet is derived, never supplied.** The caller passes one
//! `Membership` account per team and the wallet is read out of it, so a caller
//! with no way to *name* a wallet has no way to name somebody else's. That also
//! makes the funded check structural rather than a rule: a team's payee is a
//! wallet that demonstrably staked in this league.
//!
//! ## 2. Weeks are editable until finalised, and frozen after
//!
//! Write-once per week is the obvious design and it is a one-way ratchet: the
//! program holds no schedule (deliberately — see `initialize_league`), so it
//! cannot tell week 17's real result from week 17 posted in September, and a
//! single wrong index makes `compute_records` refuse **forever** with no
//! overwrite, no `close`, and after the upgrade burn no fix. A typo would cost
//! the pot.
//!
//! `finalize_week` is the explicit lock instead. It says the same thing
//! `RULES.md` §7 already says off-chain — a finalised week is never rescored —
//! without making a mistake terminal.
//!
//! ## 3. `finalized_at` is what makes the settlement hold possible
//!
//! Payout is illegal until seven days after the last week it needs was
//! finalised. That is the only bound in this design on a settlement oracle that
//! *works and lies*; everything else bounds one that is absent. See
//! `SETTLEMENT_HOLD_SECONDS`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::bracket::{build_bracket, PlayoffResult};
use crate::derive::{compute_standings, GameResult, Tiebreaker, MAX_TEAMS, MAX_WEEKS};
use crate::{prize, EscrowError, League, Membership, BASIS_POINTS_TOTAL, PRIZE_COUNT};

/// Most games one week can hold: everybody paired, nobody idle.
pub const MAX_GAMES_PER_WEEK: usize = MAX_TEAMS / 2;

/// Most links a tiebreaker chain may have. Five exist in `Tiebreaker`; the slack
/// is for appending one without a layout change.
pub const MAX_TIEBREAKERS: usize = 8;

/// Most weeks a bracket may span.
pub const MAX_PLAYOFF_WEEKS: usize = 8;

/// How long after the last needed week finalises before a payout may run.
///
/// **Seven days, and it is the only thing here that bounds a dishonest oracle.**
/// Losing the key, or never posting, is already bounded: the timelock returns
/// every stake, so members are delayed rather than robbed. None of that helps
/// when the key works and posts scores that are wrong on purpose, because that
/// happens long before the timelock opens.
///
/// Deriving the champion rather than being told it converts "post a winner" into
/// "post the scores that produce that winner" — the same authority, with a
/// public receipt. This is the gap between the receipt and the money, so that
/// the two-provider comparison `RULES.md` §7 promises can happen *before*
/// settlement rather than after it.
///
/// **It is not a veto.** Nobody gains the power to stop a payout; the hold
/// expires on its own. What it buys is time to notice, and the remedy for
/// noticing is to not send the payout at all and let the timelock refund
/// everyone — which needs no instruction and no authority, and is why it is the
/// remedy chosen.
///
/// Seven days spends about a sixth of the window between "settlement is legal"
/// and "refunds open", and matches the stat-correction number members already
/// know from finalisation.
pub const SETTLEMENT_HOLD_SECONDS: i64 = 7 * 24 * 60 * 60;

/// One team's place in the payee list.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct RosterEntry {
    /// The team's Postgres UUID, raw bytes. Feeds `LOWEST_TEAM_ID`, the last
    /// link in the default tiebreaker chain — so this is not merely a label, it
    /// participates in the seeding and cannot be replaced by the wallet.
    pub team_id: [u8; 16],
    /// Where this team's prize is paid. Read from a funded `Membership` at
    /// creation, never supplied by the caller.
    pub wallet: Pubkey,
}

/// One completed game.
///
/// **A bye is not representable, deliberately.** `compute_records` treats a bye
/// as "not a game, not a point, not a record", so posting one would change
/// nothing; making it unrepresentable removes a way to write a row that means
/// nothing and can still be got wrong.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct PostedGame {
    pub home: u8,
    pub away: u8,
    pub home_milli_points: u32,
    pub away_milli_points: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Scores {
    pub league: Pubkey,
    pub bump: u8,

    /// The only key that may post. **Compared against a `Signer`, never inferred
    /// from the instruction stack** — a program that identifies its caller
    /// through the `instruction_sysvar` breaks under a multisig, because that
    /// sysvar sees only top-level instructions and would return the multisig
    /// program's id. A stored key against a signer is unforgeable however deeply
    /// the call is nested, which is what lets this be a Squads vault address.
    pub oracle: Pubkey,

    #[max_len(MAX_TEAMS)]
    pub roster: Vec<RosterEntry>,

    // ---------------------------------------------------------------------
    // The frozen inputs the derivation needs and the oracle must not choose.
    //
    // They are here rather than on `League` because `League`'s layout is fixed
    // and this account did not exist yet. What binds them to what members signed
    // is not the program — it cannot read a rules hash — but the draw, which
    // refuses to draw an order for a league whose `Scores` terms disagree with
    // the signed document. A league that never draws never plays.
    //
    // If they were instruction arguments instead, whoever posts scores would
    // also pick the tiebreaker chain, and therefore the best-record prize
    // holder. That is the same defect as posting a standing.
    // ---------------------------------------------------------------------
    #[max_len(MAX_TIEBREAKERS)]
    pub tiebreakers: Vec<u8>,
    /// The weeks the playoff bracket may use, ascending.
    #[max_len(MAX_PLAYOFF_WEEKS)]
    pub playoff_weeks: Vec<u8>,
    /// Weeks 1..=this are the regular season, and only those feed the seeding.
    pub regular_season_weeks: u8,
    // How many top seeds reach the playoff bracket.
    //
    // **Not derivable from `first_round_byes`**, which is why it is stored
    // rather than computed. The bye count is a function of the field size and
    // that function is not invertible — two byes could mean a six-team field
    // that signed `byeSeeds: 2`, or a derived count for some other size. The
    // bracket needs the field, so the field has to be here.
    pub playoff_teams: u8,
    pub first_round_byes: u8,
    pub third_place: bool,

    /// Games by week. Index `w` holds week `w + 1`.
    #[max_len(MAX_WEEKS, MAX_GAMES_PER_WEEK)]
    pub games: Vec<Vec<PostedGame>>,

    /// Bit `w` set means week `w + 1` has been finalised and can never change.
    pub finalized_weeks: u32,

    // Set once by `settle`, and the reason a pot cannot be paid twice.
    //
    // It lives here rather than on `League` because `League`'s layout is frozen
    // and this account is not — the same reason every other settlement term is
    // here. `Scores` is created once per league and never closed, so a flag on
    // it is as permanent as one on `League` would have been.
    pub settled: bool,

    /// When the most recent week was finalised. Zero until one is.
    ///
    /// Payout reads this, not the individual weeks: the hold runs from the
    /// *last* finalisation, so a late correction to any week restarts the clock
    /// that lets somebody notice it.
    pub last_finalized_at: i64,
}

impl Scores {
    fn week_index(&self, week: u8) -> Result<usize> {
        require!(
            week >= 1 && (week as usize) <= MAX_WEEKS,
            EscrowError::UnknownWeek
        );
        Ok(week as usize - 1)
    }

    /// Whether a week is frozen.
    pub fn is_finalized(&self, week: u8) -> bool {
        match self.week_index(week) {
            Ok(index) => self.finalized_weeks & (1u32 << index) != 0,
            Err(_) => false,
        }
    }

    /// The instant a payout may first run, or `None` while nothing is finalised.
    pub fn settlement_opens_at(&self) -> Option<i64> {
        if self.last_finalized_at == 0 {
            None
        } else {
            Some(self.last_finalized_at + SETTLEMENT_HOLD_SECONDS)
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeScoresArgs {
    /// One per team, in any order — the derivation indexes by position, and the
    /// roster's own order is what those indices mean from here on.
    pub team_ids: Vec<[u8; 16]>,
    pub oracle: Pubkey,
    pub tiebreakers: Vec<u8>,
    pub playoff_weeks: Vec<u8>,
    pub regular_season_weeks: u8,
    pub playoff_teams: u8,
    pub first_round_byes: u8,
    pub third_place: bool,
}

#[derive(Accounts)]
pub struct InitializeScores<'info> {
    #[account(
        seeds = [b"league", league.league_id.as_ref()],
        bump = league.bump,
        // The commissioner creates this, not the oracle — the oracle key is
        // *content* of this account, so at creation there is nothing stored to
        // check a signer against. Anchoring it to the commissioner is what stops
        // a stranger front-running creation and writing a hostile roster, which
        // would deny settlement permanently since nothing closes this account.
        has_one = commissioner @ EscrowError::NotCommissioner,
    )]
    pub league: Box<Account<'info, League>>,

    #[account(
        init,
        payer = commissioner,
        space = 8 + Scores::INIT_SPACE,
        seeds = [b"scores", league.key().as_ref()],
        bump,
    )]
    pub scores: Box<Account<'info, Scores>>,

    #[account(mut)]
    pub commissioner: Signer<'info>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: one `Membership` per entry in `team_ids`, same order.
}

#[derive(Accounts)]
pub struct PostWeek<'info> {
    #[account(
        mut,
        seeds = [b"scores", scores.league.as_ref()],
        bump = scores.bump,
        has_one = oracle @ EscrowError::NotTheOracle,
    )]
    pub scores: Box<Account<'info, Scores>>,
    pub oracle: Signer<'info>,
}

/// Write a payee roster and the terms the derivation runs under. Once.
///
/// Refuses a league with no pot: a free league has no vault, nothing to settle,
/// and no `Membership` to derive a wallet from.
pub fn initialize_scores(ctx: Context<InitializeScores>, args: InitializeScoresArgs) -> Result<()> {
    let league = &ctx.accounts.league;
    require!(league.has_pot, EscrowError::LeagueHasNoPot);
    // Before the season is declared started, because that is the moment the
    // roster stops being checkable and the failed-league refund shuts. Members
    // get the whole window between this and `start_season` to find their own
    // row, and `start_season` is what they withhold if it is wrong.
    require!(!league.started, EscrowError::AlreadyStarted);

    let count = args.team_ids.len();
    require!(count >= 2, EscrowError::FieldTooSmall);
    require!(count <= MAX_TEAMS, EscrowError::TooManyTeams);
    require!(
        args.tiebreakers.len() >= 1 && args.tiebreakers.len() <= MAX_TIEBREAKERS,
        EscrowError::NoTiebreakers
    );
    require!(
        !args.playoff_weeks.is_empty() && args.playoff_weeks.len() <= MAX_PLAYOFF_WEEKS,
        EscrowError::NotEnoughWeeks
    );
    require!(
        args.regular_season_weeks as usize <= MAX_WEEKS,
        EscrowError::UnknownWeek
    );
    require!(
        (args.first_round_byes as usize) < count,
        EscrowError::FieldTooSmall
    );
    // The bracket field is the top seeds, capped by how many teams there are.
    // Below two there is no game to play and no champion to derive.
    require!(args.playoff_teams >= 2, EscrowError::FieldTooSmall);
    /*
      And the oracle is not the commissioner.

      The commissioner writes this account, so without this they could name
      themselves and post the scores that decide a pot they hold a stake in —
      `docs/RULES.md` §9's "not permitted, ever: anything that touches a roster,
      a score, a standing, or the pot", in one transaction.

      Off-chain the key comes from server configuration and the draw compares it
      against the signed rules, which is the stronger check. This is the one that
      binds a caller who never touched our service, and it costs a comparison.
    */
    require_keys_neq!(
        args.oracle,
        league.commissioner,
        EscrowError::OracleIsCommissioner
    );
    require_keys_neq!(args.oracle, Pubkey::default(), EscrowError::OracleMissing);

    // Every discriminant has to be one this build understands, checked now
    // rather than in December: an unknown tiebreaker written here would make the
    // derivation refuse forever, on an account that can never be rewritten.
    for value in &args.tiebreakers {
        crate::derive::Tiebreaker::from_u8(*value)?;
    }

    // One `Membership` per team, in the same order. The wallet is read out of
    // it rather than taken as an argument — see the module docs.
    require!(
        ctx.remaining_accounts.len() == count,
        EscrowError::RosterIncomplete
    );

    let mut roster: Vec<RosterEntry> = Vec::with_capacity(count);
    for (index, team_id) in args.team_ids.iter().enumerate() {
        let info = &ctx.remaining_accounts[index];
        // Deserialised by hand rather than through `Account::try_from` — the
        // borrow would have to outlive this loop iteration, and `try_deserialize`
        // checks the discriminator anyway, which is the part that matters.
        require_keys_eq!(*info.owner, crate::ID, EscrowError::NotAMembership);
        let membership = {
            let data = info.try_borrow_data()?;
            Membership::try_deserialize(&mut &data[..])
                .map_err(|_| error!(EscrowError::NotAMembership))?
        };

        require_keys_eq!(
            membership.league,
            league.key(),
            EscrowError::MembershipLeagueMismatch
        );
        // Staked, and not since withdrawn. `deposited > 0` alone reads a
        // refunded member as funded — the four `Membership` states are set out
        // in CLAUDE.md and this is the one that catches people out.
        require!(membership.deposited > 0, EscrowError::NothingDeposited);
        require!(!membership.refunded, EscrowError::AlreadyRefunded);

        // The account really is this league's membership for this wallet, and
        // not some other account that happens to deserialize.
        let (expected, _) = Pubkey::find_program_address(
            &[
                b"membership",
                league.key().as_ref(),
                membership.member.as_ref(),
            ],
            ctx.program_id,
        );
        require_keys_eq!(info.key(), expected, EscrowError::MembershipMemberMismatch);

        // No wallet twice: two teams sharing a payee would send both prizes to
        // one person and leave a real member unpayable.
        require!(
            !roster
                .iter()
                .any(|e: &RosterEntry| e.wallet == membership.member),
            EscrowError::DuplicateRosterEntry
        );
        require!(
            !roster.iter().any(|e: &RosterEntry| e.team_id == *team_id),
            EscrowError::DuplicateRosterEntry
        );

        roster.push(RosterEntry {
            team_id: *team_id,
            wallet: membership.member,
        });
    }

    let scores = &mut ctx.accounts.scores;
    scores.league = league.key();
    scores.bump = ctx.bumps.scores;
    scores.oracle = args.oracle;
    scores.roster = roster;
    scores.tiebreakers = args.tiebreakers;
    scores.playoff_weeks = args.playoff_weeks;
    scores.regular_season_weeks = args.regular_season_weeks;
    scores.playoff_teams = args.playoff_teams;
    scores.first_round_byes = args.first_round_byes;
    scores.third_place = args.third_place;
    scores.games = vec![Vec::new(); MAX_WEEKS];
    scores.finalized_weeks = 0;
    scores.last_finalized_at = 0;
    scores.settled = false;

    Ok(())
}

/// Replace a week's games. Legal until that week is finalised.
pub fn post_week(ctx: Context<PostWeek>, week: u8, games: Vec<PostedGame>) -> Result<()> {
    let scores = &mut ctx.accounts.scores;
    let index = scores.week_index(week)?;
    require!(!scores.is_finalized(week), EscrowError::WeekAlreadyFinal);
    require!(games.len() <= MAX_GAMES_PER_WEEK, EscrowError::TooManyGames);

    let teams = scores.roster.len() as u8;
    for game in &games {
        require!(game.home < teams, EscrowError::UnknownTeam);
        require!(game.away < teams, EscrowError::UnknownTeam);
        // A team cannot play itself, and the derivation would silently credit
        // both halves of the result to one record.
        require!(game.home != game.away, EscrowError::MalformedSchedule);
    }

    scores.games[index] = games;
    Ok(())
}

/// Freeze a week. Nothing can change it afterwards, and the settlement hold
/// restarts from now.
pub fn finalize_week(ctx: Context<PostWeek>, week: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let scores = &mut ctx.accounts.scores;
    let index = scores.week_index(week)?;
    require!(!scores.is_finalized(week), EscrowError::WeekAlreadyFinal);

    scores.finalized_weeks |= 1u32 << index;
    // The hold runs from the most recent finalisation rather than from week 17
    // specifically, so a week corrected and frozen late restarts the window in
    // which somebody can notice it.
    scores.last_finalized_at = now;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settlement — D6/G9
// ---------------------------------------------------------------------------

/// The prizes this program can derive, and therefore the only ones it can pay.
///
/// Champion, runner-up and best regular-season record: all three are decidable
/// in a league of any size, which is why `docs/RULES.md` §7's two built-in
/// payouts name exactly these. Consolation and third place are not — they depend
/// on how many people joined, and the payout is frozen before anyone does — so a
/// league whose split pays either is refused here rather than paid wrongly. Its
/// members take the timelock refund, which is the correct failure and the one
/// `validateLeagueRules` cannot prevent, since the field size is unknown at
/// creation.
fn payable(payout_bps: &[u16; PRIZE_COUNT]) -> Result<()> {
    require!(
        payout_bps[prize::CONSOLATION] == 0 && payout_bps[prize::THIRD_PLACE] == 0,
        EscrowError::PrizeNotDerivable
    );
    Ok(())
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"league", league.league_id.as_ref()],
        bump = league.bump,
    )]
    pub league: Box<Account<'info, League>>,

    #[account(
        mut,
        seeds = [b"scores", league.key().as_ref()],
        bump = scores.bump,
        has_one = oracle @ EscrowError::NotTheOracle,
    )]
    pub scores: Box<Account<'info, Scores>>,

    /// Signed, and it authorises nothing about the result — see the docs below.
    pub oracle: Signer<'info>,

    #[account(mut, seeds = [b"vault", league.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub champion_tokens: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub runner_up_tokens: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub regular_season_tokens: Box<Account<'info, TokenAccount>>,
    /// Where the protocol fee goes. Required even at `fee_bps == 0`, where
    /// nothing is sent to it — one account list is easier to get right than two,
    /// and a zero transfer is skipped rather than issued.
    #[account(mut)]
    pub fee_tokens: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Pay a league's prizes, once, from scores nobody may still dispute.
///
/// ## Nobody declares a winner, including whoever sends this
///
/// The oracle signs it and that signature authorises **nothing about the
/// result**. Every recipient is derived here from the posted scores — records,
/// tiebreakers, the bracket — by the kernels `standings-corpus.json` and
/// `bracket-corpus.json` pin against the TypeScript. There is no argument to
/// this instruction naming a team, a wallet or an amount. That is what
/// `docs/RULES.md` §7 means, and PR #31 was closed for offering the opposite.
///
/// The signature exists so a stranger cannot fire settlement at a moment of
/// their choosing, and for nothing else. Anyone can compute the same answer.
///
/// ## Four conditions, each load-bearing
///
/// - **`started`.** `refund_stake` has a second opening for a league that never
///   began — `!started && now >= start_deadline` — which falls months before
///   this. Paying out a league that is simultaneously refundable drains the
///   vault twice, and this is the half that can only ever refuse to pay.
/// - **Before `refund_unlock_at`.** The other half of the same exclusion. After
///   it, the timelock is open and the money belongs to whoever asks first.
/// - **[`SETTLEMENT_HOLD_SECONDS`] past the last finalisation.** Time for anyone
///   to compare the posted scores against the providers before they buy
///   anything. The only bound here on an oracle that works and lies.
/// - **Every week the derivation reads is frozen.** A prize computed from a week
///   that can still be rewritten is a prize computed from a draft.
///
/// ## The pot is the roster, not the vault
///
/// `join_league` is permissionless, so anyone may open a `Membership` and
/// deposit into any league they can name. The vault balance and
/// `total_deposited` both therefore include money that is not the pot, and
/// paying a percentage of either would hand a stranger's stake to the winners
/// and leave the vault short when that stranger refunds.
///
/// So the pot is `roster.len() × buy_in` — the members this league actually has,
/// each verified funded when the roster was written. `total_deposited` is
/// decremented by exactly that and **never zeroed**, so a stranger's own stake
/// is still behind the timelock waiting for them. Zeroing it is what broke the
/// refund in PR #31.
pub fn settle(ctx: Context<Settle>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    {
        let league = &ctx.accounts.league;
        let scores = &ctx.accounts.scores;

        require!(league.has_pot, EscrowError::LeagueHasNoPot);
        require!(!scores.settled, EscrowError::AlreadySettled);
        require!(league.started, EscrowError::SeasonNotStarted);
        require!(now < league.refund_unlock_at, EscrowError::RefundWindowOpen);
        require_keys_eq!(
            scores.league,
            league.key(),
            EscrowError::MembershipLeagueMismatch
        );
        payable(&league.payout_bps)?;

        let opens_at = scores
            .settlement_opens_at()
            .ok_or(EscrowError::NoWeekFinalised)?;
        require!(now >= opens_at, EscrowError::SettlementHeld);

        for week in 1..=scores.regular_season_weeks {
            require!(scores.is_finalized(week), EscrowError::WeekNotFinal);
        }
        for week in scores.playoff_weeks.iter() {
            require!(scores.is_finalized(*week), EscrowError::WeekNotFinal);
        }
    }

    let winners = ctx.accounts.scores.derive_winners()?;

    let teams = ctx.accounts.scores.roster.len() as u64;
    let buy_in = ctx.accounts.league.buy_in;
    let pot = teams.checked_mul(buy_in).ok_or(EscrowError::MathOverflow)?;
    require!(
        pot <= ctx.accounts.league.total_deposited,
        EscrowError::VaultShort
    );
    require!(pot <= ctx.accounts.vault.amount, EscrowError::VaultShort);

    let fee = mul_bps(pot, ctx.accounts.league.fee_bps)?;
    let distributable = pot.checked_sub(fee).ok_or(EscrowError::MathOverflow)?;

    let payout_bps = ctx.accounts.league.payout_bps;
    let runner_up = mul_bps(distributable, payout_bps[prize::RUNNER_UP])?;
    let regular_season = mul_bps(distributable, payout_bps[prize::REGULAR_SEASON])?;
    // The champion takes the remainder rather than their own basis points, which
    // is that number plus whatever integer division left behind. Dust in a vault
    // nothing can close is dust nobody can ever have — and the champion holds the
    // largest share by rule, so this cannot reorder the prizes.
    let champion = distributable
        .checked_sub(runner_up)
        .and_then(|rest| rest.checked_sub(regular_season))
        .ok_or(EscrowError::PayoutExceedsPot)?;

    let mint = ctx.accounts.league.token_mint;
    check_destination(
        &ctx.accounts.champion_tokens,
        &ctx.accounts.scores,
        winners.champion,
        mint,
    )?;
    check_destination(
        &ctx.accounts.runner_up_tokens,
        &ctx.accounts.scores,
        winners.runner_up,
        mint,
    )?;
    check_destination(
        &ctx.accounts.regular_season_tokens,
        &ctx.accounts.scores,
        winners.regular_season,
        mint,
    )?;
    if fee > 0 {
        require_keys_eq!(
            ctx.accounts.fee_tokens.owner,
            ctx.accounts.league.fee_recipient,
            EscrowError::FeeRecipientMissing
        );
        require_keys_eq!(ctx.accounts.fee_tokens.mint, mint, EscrowError::WrongMint);
    }

    let league_id = ctx.accounts.league.league_id;
    let bump = ctx.accounts.league.bump;
    let seeds: &[&[u8]] = &[b"league", league_id.as_ref(), &[bump]];
    let signer: &[&[&[u8]]] = &[seeds];

    for (amount, to) in [
        (champion, ctx.accounts.champion_tokens.to_account_info()),
        (runner_up, ctx.accounts.runner_up_tokens.to_account_info()),
        (
            regular_season,
            ctx.accounts.regular_season_tokens.to_account_info(),
        ),
        (fee, ctx.accounts.fee_tokens.to_account_info()),
    ] {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to,
                    authority: ctx.accounts.league.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
    }

    // Decremented, never zeroed. A stranger who deposited into this league still
    // has their own stake waiting behind the timelock.
    ctx.accounts.league.total_deposited = ctx
        .accounts
        .league
        .total_deposited
        .checked_sub(pot)
        .ok_or(EscrowError::MathOverflow)?;
    ctx.accounts.scores.settled = true;

    Ok(())
}

/// `amount * bps / 10000`, in `u128` so the multiply cannot wrap.
fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    let scaled = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(EscrowError::MathOverflow)?
        / (BASIS_POINTS_TOTAL as u128);
    u64::try_from(scaled).map_err(|_| error!(EscrowError::MathOverflow))
}

/// A prize destination has to belong to the team that won it.
///
/// The roster is the only thing on-chain connecting a team to a wallet, and it
/// was written before the season with every entry verified against a funded
/// `Membership`. Checking the token account's owner against it is what stops a
/// caller redirecting a prize: the derivation decides *which team*, and this
/// decides that the account really is theirs.
fn check_destination(
    account: &Account<TokenAccount>,
    scores: &Scores,
    team: u8,
    mint: Pubkey,
) -> Result<()> {
    let entry = scores
        .roster
        .get(team as usize)
        .ok_or(EscrowError::UnknownTeam)?;
    require_keys_eq!(account.owner, entry.wallet, EscrowError::WrongPrizeAccount);
    require_keys_eq!(account.mint, mint, EscrowError::WrongMint);
    Ok(())
}

/// Who a league's three payable prizes belong to, as roster indices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Winners {
    pub champion: u8,
    pub runner_up: u8,
    /// Seed 1 of the regular season.
    pub regular_season: u8,
}

impl Scores {
    /// Derive the three payable prize-holders from the posted scores.
    ///
    /// **This is the whole of "no one declares a winner".** Nothing is stored
    /// about who won and nothing is passed in; the answer is recomputed from the
    /// games every time, by the same kernels the corpora pin against the
    /// TypeScript members can run themselves. A wrong result here is a wrong
    /// result anyone holding the same account can demonstrate.
    ///
    /// The two halves come from different weeks and must not be confused. The
    /// regular-season prize is seed 1 of weeks 1..=`regular_season_weeks` — it
    /// is decided in week 14 and paid in January with the rest (`RULES.md` §7).
    /// The champion and runner-up come out of the bracket those seeds enter.
    pub fn derive_winners(&self) -> Result<Winners> {
        let mut ids = [[0u8; 16]; MAX_TEAMS];
        for (index, entry) in self.roster.iter().enumerate() {
            ids[index] = entry.team_id;
        }
        let team_count = self.roster.len();

        let mut chain = [Tiebreaker::WinPct; MAX_TIEBREAKERS];
        for (index, raw) in self.tiebreakers.iter().enumerate() {
            chain[index] = Tiebreaker::from_u8(*raw)?;
        }

        // Regular-season games only. A playoff result counting toward a record
        // would move the seeds the bracket was built from, and the standings
        // would chase the results they produced — the bug `loadWeekResults`
        // already had once.
        let mut regular = [GameResult {
            home: 0,
            away: None,
            home_milli_points: 0,
            away_milli_points: 0,
        }; MAX_GAMES_PER_WEEK * MAX_WEEKS];
        let mut count = 0usize;
        for week in 1..=self.regular_season_weeks {
            let index = self.week_index(week)?;
            for game in &self.games[index] {
                regular[count] = GameResult {
                    home: game.home,
                    away: Some(game.away),
                    home_milli_points: game.home_milli_points,
                    away_milli_points: game.away_milli_points,
                };
                count += 1;
            }
        }

        let (seeds, seeded) = compute_standings(
            &ids[..team_count],
            &regular[..count],
            &chain[..self.tiebreakers.len()],
        )?;
        require!(seeded >= 2, EscrowError::FieldTooSmall);

        // The bracket takes the top seeds, capped by the field that formed.
        let field_size = (self.playoff_teams as usize).min(seeded);
        let mut field = [0u8; MAX_TEAMS];
        for (index, seed) in seeds[..field_size].iter().enumerate() {
            field[index] = seed.team;
        }

        let mut playoff = [PlayoffResult {
            week: 0,
            home: 0,
            away: 0,
            home_milli_points: 0,
            away_milli_points: 0,
        }; MAX_GAMES_PER_WEEK * MAX_PLAYOFF_WEEKS];
        let mut played = 0usize;
        for week in self.playoff_weeks.iter() {
            let index = self.week_index(*week)?;
            for game in &self.games[index] {
                playoff[played] = PlayoffResult {
                    week: *week,
                    home: game.home,
                    away: game.away,
                    home_milli_points: game.home_milli_points,
                    away_milli_points: game.away_milli_points,
                };
                played += 1;
            }
        }

        let bracket = build_bracket(
            &field[..field_size],
            &self.playoff_weeks,
            self.first_round_byes as usize,
            &playoff[..played],
            self.third_place,
        )?;

        // Refused rather than defaulted. A bracket that has not resolved has no
        // champion, and paying "whoever is top of the array" would settle a
        // season that is not over.
        let champion = bracket.champion.ok_or(EscrowError::BracketUnresolved)?;
        let runner_up = bracket.runner_up.ok_or(EscrowError::BracketUnresolved)?;

        Ok(Winners {
            champion,
            runner_up,
            // Seed 1 of the regular season, which is a different question from
            // who won the bracket and frequently a different team.
            regular_season: seeds[0].team,
        })
    }
}

#[cfg(test)]
mod derivation {
    //! `derive_winners`, against a constructed season.
    //!
    //! **This is the correctness test the program tests cannot be.** The token
    //! transfers in `settle` are gated behind a seven-day hold, which a wall-clock
    //! validator cannot reach, so the validator suite covers every *refusal* and
    //! not the successful payout. What it can never cover either way is the part
    //! that actually decides who is paid — and that part is pure, so it is tested
    //! here where no clock is involved.
    //!
    //! The kernels themselves are pinned against the TypeScript by the two
    //! corpora. This tests the wiring between them: that the regular season feeds
    //! the seeding and the playoff weeks feed the bracket, that the two are not
    //! confused, and that an unresolved bracket refuses rather than defaulting.

    use super::*;

    fn team_id(n: u8) -> [u8; 16] {
        let mut id = [0u8; 16];
        id[15] = n;
        id
    }

    /// Four teams, a three-week regular season, a two-week bracket.
    fn league(regular: &[(u8, u8, u8, u32, u32)], playoff: &[(u8, u8, u8, u32, u32)]) -> Scores {
        let mut games = vec![Vec::new(); MAX_WEEKS];
        for (week, home, away, hp, ap) in regular.iter().chain(playoff.iter()) {
            games[*week as usize - 1].push(PostedGame {
                home: *home,
                away: *away,
                home_milli_points: *hp,
                away_milli_points: *ap,
            });
        }

        Scores {
            league: Pubkey::default(),
            bump: 0,
            oracle: Pubkey::default(),
            roster: (0..4)
                .map(|n| RosterEntry {
                    team_id: team_id(n),
                    wallet: Pubkey::default(),
                })
                .collect(),
            tiebreakers: vec![0, 1, 4],
            playoff_weeks: vec![4, 5],
            regular_season_weeks: 3,
            playoff_teams: 4,
            first_round_byes: 0,
            third_place: false,
            settled: false,
            games,
            finalized_weeks: 0,
            last_finalized_at: 0,
        }
    }

    /// Team 0 wins every regular-season game, team 1 wins two, and so on, so the
    /// seeding is 0, 1, 2, 3 and nothing rests on a tiebreaker.
    const CHALK: [(u8, u8, u8, u32, u32); 6] = [
        (1, 0, 3, 100_000, 10_000),
        (1, 1, 2, 100_000, 10_000),
        (2, 0, 2, 100_000, 10_000),
        (2, 1, 3, 100_000, 10_000),
        (3, 0, 1, 100_000, 10_000),
        (3, 2, 3, 100_000, 10_000),
    ];

    #[test]
    fn derives_the_champion_from_the_bracket_and_seed_one_from_the_season() {
        // Semifinals reseed 1v4 and 2v3; then the final. Team 3 upsets team 0 in
        // the semifinal and goes on to win, which is the point of the case: the
        // champion and the regular-season prize must come out different, because
        // they are different questions asked of different weeks.
        let scores = league(
            &CHALK,
            &[
                (4, 0, 3, 10_000, 100_000),
                (4, 1, 2, 100_000, 10_000),
                (5, 1, 3, 10_000, 100_000),
            ],
        );

        let winners = scores.derive_winners().expect("a resolved bracket");
        assert_eq!(winners.champion, 3, "champion");
        assert_eq!(winners.runner_up, 1, "runner-up");
        assert_eq!(winners.regular_season, 0, "best regular-season record");
    }

    #[test]
    fn playoff_results_do_not_move_the_seeding() {
        // The bug `loadWeekResults` already had once: a bracket game counting
        // toward a record moves the seeds the bracket was built from, and the
        // standings chase the results they produced. Team 3 wins two blowouts in
        // the playoffs; seed 1 must not budge.
        let with_playoffs = league(
            &CHALK,
            &[
                (4, 0, 3, 1, 500_000),
                (4, 1, 2, 100_000, 10_000),
                (5, 1, 3, 1, 500_000),
            ],
        );
        assert_eq!(with_playoffs.derive_winners().unwrap().regular_season, 0);
    }

    #[test]
    fn an_unresolved_bracket_refuses_rather_than_crowning_somebody() {
        // Only the semifinals are in. Paying "whoever is top of the array" would
        // settle a season that is not over, and every other check in `settle`
        // would have passed.
        let scores = league(
            &CHALK,
            &[(4, 0, 3, 100_000, 10_000), (4, 1, 2, 100_000, 10_000)],
        );
        let error = scores.derive_winners().expect_err("no champion yet");
        let expected: u32 = EscrowError::BracketUnresolved.into();
        assert!(
            matches!(
                error,
                anchor_lang::error::Error::AnchorError(ref inner)
                    if inner.error_code_number == expected
            ),
            "expected BracketUnresolved, got {error:?}",
        );
    }

    #[test]
    fn the_pot_is_the_roster_and_the_champion_takes_the_dust() {
        // The arithmetic `settle` performs, checked here because the transfers it
        // performs cannot be reached on a wall-clock validator.
        //
        // A buy-in that does not divide cleanly, so the rounding is real: four
        // members at 3333333, a 1% fee, then 70/20/10 of what is left.
        let pot: u64 = 4 * 3_333_333;
        let fee = mul_bps(pot, 100).unwrap();
        let distributable = pot - fee;
        let runner_up = mul_bps(distributable, 2000).unwrap();
        let regular = mul_bps(distributable, 1000).unwrap();
        let champion = distributable - runner_up - regular;

        // Nothing is stranded: every base unit of the pot is either paid or
        // charged as fee. Dust in a vault nothing can close is dust nobody can
        // ever have.
        assert_eq!(champion + runner_up + regular + fee, pot);
        // And the champion still holds the largest share, which is a rule.
        assert!(champion > runner_up && runner_up > regular);
    }

    #[test]
    fn a_payout_naming_an_underivable_prize_is_refused() {
        // Consolation and third place depend on how many people joined, and the
        // payout is frozen before anyone does. `validateLeagueRules` cannot catch
        // it — the field size is unknown at creation — so this is where it stops.
        let mut bps = [0u16; PRIZE_COUNT];
        bps[prize::CHAMPION] = 7000;
        bps[prize::RUNNER_UP] = 2000;
        bps[prize::THIRD_PLACE] = 1000;
        assert!(payable(&bps).is_err());

        bps[prize::THIRD_PLACE] = 0;
        bps[prize::REGULAR_SEASON] = 1000;
        assert!(payable(&bps).is_ok());
    }
}
