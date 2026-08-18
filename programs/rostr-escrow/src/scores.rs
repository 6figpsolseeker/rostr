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

use crate::derive::{MAX_TEAMS, MAX_WEEKS};
use crate::{EscrowError, League, Membership};

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
    pub first_round_byes: u8,
    pub third_place: bool,

    /// Games by week. Index `w` holds week `w + 1`.
    #[max_len(MAX_WEEKS, MAX_GAMES_PER_WEEK)]
    pub games: Vec<Vec<PostedGame>>,

    /// Bit `w` set means week `w + 1` has been finalised and can never change.
    pub finalized_weeks: u32,

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
    scores.first_round_byes = args.first_round_byes;
    scores.third_place = args.third_place;
    scores.games = vec![Vec::new(); MAX_WEEKS];
    scores.finalized_weeks = 0;
    scores.last_finalized_at = 0;

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
