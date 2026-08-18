//! Escrow for rostr league pots.
//!
//! The program's job is narrow on purpose: hold everyone's buy-in, and release
//! it only in ways the league's frozen rules already describe. It decides
//! nothing. The rule set lives off-chain, canonically encoded and SHA-256
//! hashed (`packages/core/src/canonical.ts`), and only that hash is stored here
//! — so a member who signs a join has cryptographically accepted the exact
//! document, and no later edit to a database row can change what they agreed
//! to.
//!
//! **Immutability is by omission.** There is no instruction that mutates a
//! `League`'s configuration after `initialize_league`. That is the enforcement
//! — not a flag, not an authority check that could be mis-signed. If you find
//! yourself adding a setter here, re-read docs/DECISIONS.md § "Rules are
//! immutable, and shown before joining"; the answer to a wrong rule set is a
//! new league, not an edited one.
//!
//! **Legacy SPL Token only, deliberately.** `anchor_spl::token`, not
//! `token_interface`. A Token-2022 mint carrying the transfer-fee extension
//! would deliver less to the vault than the member sent, quietly breaking the
//! rule that everyone stakes the identical amount — and a transfer hook is
//! arbitrary code in the middle of a deposit. Supporting Token-2022 for the pot
//! is a real audit surface for a benefit nobody has asked for; USDC, the
//! expected pot token, is a legacy SPL mint. Roster NFTs in Milestone E are
//! Token-2022 and unrelated to this file.
//!
//! **Scope:** this program serves leagues that play for money. A league with
//! `pot: null` has nothing to escrow and never calls it. Anchoring a free
//! league's rules hash on-chain is a separate question — flagged, not answered.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("FtXXoS8G6N3dmhijp2kZGpmX6GmNtDk6cGj9h7eoK5NC");

/// The playoff ladder, derived rather than declared — the second half of the
/// kernel `derive` starts. Champion, runner-up, third place.
///
/// Pinned to `buildBracket` by `bracket-corpus.json`, in the pattern the
/// standings corpus established. See `docs/SETTLEMENT.md`.
pub mod bracket;

/// Seeding, derived rather than declared — the first half of issue #28.
///
/// **No instruction calls either kernel yet, deliberately.** `docs/RULES.md` § 7
/// requires the contract to derive the champion from posted scores, which needs
/// the standings this computes; posting those scores needs the dual-source
/// oracle (G4–G5) that does not exist. So the kernels land first, alone, where
/// they can be reviewed against the TypeScript that decides the same question
/// today and nothing depends on them being right yet.
///
/// They change no account and no instruction, so they cannot move
/// `potDepositGate` — mainnet stays shut until an instruction named `settle`
/// exists, which is several commits away.
///
/// **This used to say "and no IDL", and that is no longer true.** Their refusals
/// are variants of [`EscrowError`], so the IDL's error block grows with them.
/// The alternative — a second `#[error_code]` enum — does not add to the IDL,
/// it replaces it; see the comment on those variants.
pub mod derive;

/// Number of prizes in a payout split. Fixed at five by the rule schema:
/// champion, runner-up, regular season, consolation, third place.
pub const PRIZE_COUNT: usize = 5;

/// 100%, in basis points. Mirrors `BASIS_POINTS_TOTAL` in `packages/core`.
pub const BASIS_POINTS_TOTAL: u16 = 10_000;

/// Positional indices into [`League::payout_bps`].
///
/// The array is positional rather than keyed because storing five string keys
/// on-chain would cost bytes to express something both sides already agree on.
/// **The client must serialise from PRIZE_ORDER in packages/escrow/src/
/// instructions.ts, which mirrors this module.** Not from the declaration order
/// of the `PrizeKey` union, and not from whichever prizes a payout happens to
/// name — a built-in payout may name only three, and the two it omits are sent
/// as zero in their own slots. Serialising from anything else reshuffles the
/// split with no error anywhere.
pub mod prize {
    pub const CHAMPION: usize = 0;
    pub const RUNNER_UP: usize = 1;
    pub const REGULAR_SEASON: usize = 2;
    pub const CONSOLATION: usize = 3;
    pub const THIRD_PLACE: usize = 4;
}

/// Maximum buy-in: $50, in a six-decimal stablecoin's base units.
///
/// A ceiling, not a price — a league may stake any amount up to it. The single
/// largest lever on exposure while the program is unaudited: identical code and
/// an identical bug risks $600 across a 12-person league at this cap, where $500
/// a head would risk $6,000. Enforced here rather than in the UI so that it
/// binds every caller, not only the ones who came through our front end.
pub const MAX_BUY_IN_BASE_UNITS: u64 = 50_000_000;

/// Minimum buy-in: $5, in the same base units.
///
/// A floor exists because a pot has fixed costs that a stake does not scale
/// with. Every member's deposit and refund is a transaction, the vault and each
/// membership account cost rent, and settlement pays out every prize in the
/// frozen split — at a
/// one-cent buy-in the fees to move the money exceed the money. A pot that small
/// is also indistinguishable from a free league, which has its own instruction
/// and needs none of this machinery.
///
/// It bites hardest on the smallest split: 5% of a $5 stake in a two-team league
/// is 25 cents, which is still a real transfer rather than dust.
pub const MIN_BUY_IN_BASE_UNITS: u64 = 5_000_000;

/// Pot tokens must have exactly six decimals.
///
/// This is what makes [`MAX_BUY_IN_BASE_UNITS`] mean "fifty dollars" rather than
/// fifty million of something. Base units are mint-specific: the same constant
/// is 50 USDC at six decimals but 0.05 SOL at nine, so without this the cap
/// silently means a different amount for every token.
///
/// **It narrows docs/RULES.md § 7 for season one**, which permits any SPL token.
/// Six decimals is the stablecoin convention (USDC, USDT), so this is "pots are
/// denominated in dollars" expressed as tightly as a program can express it
/// without a price oracle.
///
/// **It is not a proof of value, and the gap matters.** Nothing stops a
/// six-decimal token that is worth far more, or far less, than a dollar. Pinning
/// the actual USDC mint address closes that, and must happen before mainnet —
/// see docs/SETUP-REQUIRED.md.
pub const POT_MINT_DECIMALS: u8 = 6;

/// Ceiling on the protocol fee, in basis points. 5%.
///
/// Mirrors `MAX_FEE_BPS` in `packages/core/src/rules/types.ts`. The per-league
/// fee is frozen at creation and defaults to 1%; this is the most a league may
/// ever be created with, enforced on-chain so the ceiling is not merely our
/// promise.
pub const MAX_FEE_BPS: u16 = 500;

/// Smallest league that can meaningfully play.
pub const MIN_TEAMS: u8 = 2;

/// Largest league this program can settle. `docs/RULES.md` §3, and
/// **not the same constant as `derive::MAX_TEAMS`**, which is the kernels'
/// array capacity and carries headroom above this. Named for the TypeScript it
/// mirrors so the two cannot be confused at a glance.
///
/// `MAX_TEAMS_PER_LEAGUE` in `packages/core/src/rules/validate.ts`.
///
/// **A settlement bound, not a scheduling one**, and it had no on-chain half
/// until 2026-08-17. `max_teams` is published and not enforced against the
/// roster (see the field), but this is a different question: the derivation
/// kernels in `derive.rs` and `bracket.rs` size fixed arrays to `MAX_TEAMS` and
/// refuse above it, so a league anchored over this cap would play a whole season
/// and then be **unsettleable** — its members falling to the timelock refund
/// with no earlier signal.
///
/// Checked here rather than only off-chain for the same reason the buy-in bounds
/// are: it binds every caller, not only the ones who came through our front end.
/// Checked at creation rather than at settlement because the rules are frozen —
/// a bound applied later could only ever trap money in a league that already
/// exists.
pub const MAX_TEAMS_PER_LEAGUE: u8 = 12;

/// Furthest into the future a refund unlock may be set, measured from the moment
/// the league account is created. Two years.
///
/// A backstop rather than the real bound — see the comment at its use in
/// `initialize_league`. It is the smallest horizon that cannot falsely reject a
/// league the off-chain validator would permit, which is the property that
/// matters here, because a refusal at this point cannot be retried.
pub const MAX_REFUND_UNLOCK_HORIZON_SECONDS: i64 = 730 * 24 * 60 * 60;

#[program]
pub mod rostr_escrow {
    use super::*;

    /// Create the on-chain record of a league, freeze its terms, and open its
    /// vault.
    ///
    /// Everything validated here is validated again off-chain by
    /// `validateRules()` before a league is written to Postgres. The duplication
    /// is deliberate: the off-chain check produces good error messages for a
    /// league creator, and this one is what actually binds, because it is the
    /// only one an attacker cannot skip by calling the program directly.
    pub fn initialize_league(
        ctx: Context<InitializeLeague>,
        args: InitializeLeagueArgs,
    ) -> Result<()> {
        // A zero hash would mean "no rules", which must never be a league that
        // can take money. It is also what an uninitialised buffer looks like.
        require!(args.rules_hash != [0u8; 32], EscrowError::RulesHashMissing);

        // Zero gets its own error rather than falling into "below the minimum",
        // because it almost always means the caller wanted a free league and
        // reached for the wrong instruction.
        require!(args.buy_in > 0, EscrowError::BuyInZero);
        require!(
            args.buy_in >= MIN_BUY_IN_BASE_UNITS,
            EscrowError::BuyInBelowMinimum
        );
        require!(
            args.buy_in <= MAX_BUY_IN_BASE_UNITS,
            EscrowError::BuyInAboveCap
        );

        require!(args.max_teams >= MIN_TEAMS, EscrowError::LeagueTooSmall);
        require!(
            args.max_teams <= MAX_TEAMS_PER_LEAGUE,
            EscrowError::LeagueTooLarge
        );

        // Without this the cap above means a different amount of money for every
        // token. See POT_MINT_DECIMALS.
        require!(
            ctx.accounts.mint.decimals == POT_MINT_DECIMALS,
            EscrowError::UnsupportedMintDecimals
        );

        // A fee of zero is legitimate. Anything above the ceiling is not, and the
        // ceiling is on-chain so it is not merely our promise.
        require!(args.fee_bps <= MAX_FEE_BPS, EscrowError::FeeAboveCeiling);
        require!(
            args.fee_bps == 0 || args.fee_recipient != Pubkey::default(),
            EscrowError::FeeRecipientMissing
        );

        // The shares must account for the entire pot. Anything less would leave
        // a remainder with no owner and no instruction able to move it.
        let total: u32 = args.payout_bps.iter().map(|bps| u32::from(*bps)).sum();
        require!(
            total == u32::from(BASIS_POINTS_TOTAL),
            EscrowError::PayoutNotWhole
        );

        // "The champion must always hold the largest single share" —
        // docs/RULES.md § 7. Strictly greatest, so a tie cannot make second
        // place equal to winning.
        let champion = args.payout_bps[prize::CHAMPION];
        require!(
            args.payout_bps
                .iter()
                .enumerate()
                .all(|(i, bps)| i == prize::CHAMPION || *bps < champion),
            EscrowError::ChampionNotLargest
        );

        // The refund unlock is the promise that funds can never be permanently
        // stuck. One already in the past would let the first depositor withdraw
        // immediately; one at zero would mean the caller never set it.
        let now = Clock::get()?.unix_timestamp;
        require!(
            args.refund_unlock_at > now,
            EscrowError::RefundUnlockNotInFuture
        );

        // And a ceiling, because a date decades out is not a longer timelock —
        // it is a permanent freeze. `refund_stake` is the only instruction that
        // moves tokens out of the vault, there is no settlement instruction yet,
        // and there is no setter or authority that could release them sooner.
        //
        // This cannot be the league's own settlement date. The program has no
        // schedule — `rules_hash` is 32 opaque bytes to it — and any schedule
        // passed in as an argument would be chosen by the same caller as the
        // date, so the check would compare an attacker's input against their own
        // input and read as a guarantee while being none. The clock is the only
        // input here that the caller does not supply.
        //
        // `now` at initialisation is a sound lower bound on the first possible
        // deposit, since `deposit` has no time condition and this account must
        // exist before one can happen — so this bounds how long any stake can be
        // locked without the program knowing anything about a season.
        //
        // **Deliberately loose, and do not tighten it.** The precise bound lives
        // off-chain in `validatePot`, where the season is known. A false refusal
        // here is unrecoverable: the args come from a rule set that is already
        // frozen, so the league cannot be retried with a corrected value, and
        // the PDA derives from its UUID — it could only be recreated under a new
        // id. `MAX_DRAFT_LEAD_MS` in the create route keeps the off-chain
        // maximum at draft + 365d with a draft at most 300d out, so 665 days is
        // the most a legitimate league can ask for and this leaves 65 days spare.
        //
        // `saturating_add` rather than `+`: overflow here is unreachable in
        // practice, and a panic is a worse answer to a hostile argument than a
        // comparison that simply fails. With saturation `i64::MAX` still fails.
        require!(
            args.refund_unlock_at <= now.saturating_add(MAX_REFUND_UNLOCK_HORIZON_SECONDS),
            EscrowError::RefundUnlockTooFar
        );

        // The deadline for declaring the season started, after which a league
        // that never did releases every stake. One in the past would open the
        // failed-league refund before anyone could deposit, so the first stake
        // could be withdrawn immediately — the same failure `refund_unlock_at >
        // now` prevents for the ordinary timelock.
        require!(
            args.start_deadline > now,
            EscrowError::StartDeadlineNotInFuture
        );

        // The two refund openings must be ordered, and strictly.
        //
        // If the failed-league opening came at or after the timelock it would be
        // dead code, and worse, `start_season` would still be legal past the
        // point where the ordinary refund had already released stakes — a league
        // could be declared started with a drained vault. Off-chain this cannot
        // happen, since `earliestRefundUnlock` puts the timelock a season and
        // sixty days beyond the draft, so this rejects only a caller who
        // bypassed it.
        require!(
            args.start_deadline < args.refund_unlock_at,
            EscrowError::StartDeadlineAfterRefundUnlock
        );

        let league = &mut ctx.accounts.league;
        league.league_id = args.league_id;
        league.rules_hash = args.rules_hash;
        // Taken from the mint account rather than an argument, so the stored
        // mint and the vault's mint cannot disagree.
        league.token_mint = ctx.accounts.mint.key();
        league.buy_in = args.buy_in;
        league.refund_unlock_at = args.refund_unlock_at;
        league.payout_bps = args.payout_bps;
        league.fee_bps = args.fee_bps;
        league.fee_recipient = args.fee_recipient;
        league.has_pot = true;
        league.max_teams = args.max_teams;
        league.member_count = 0;
        league.total_deposited = 0;
        league.bump = ctx.bumps.league;
        // The one key on this account, and it can only ever call `start_season`.
        league.commissioner = ctx.accounts.payer.key();
        league.start_deadline = args.start_deadline;
        league.started = false;

        Ok(())
    }

    /// Declare that this league's season has begun, closing the failed-league
    /// refund.
    ///
    /// ## What this is for
    ///
    /// A league that is not ready at its draft time — short of its buy-ins, or
    /// with an odd field — must give everyone their money back **then**, not in
    /// six months. But this program cannot tell a failed league from a running
    /// one: the roster, the draft and who has paid are Postgres facts, and
    /// `rules_hash` is 32 opaque bytes to it. Something has to say so.
    ///
    /// So the default is failure. A league that was ready calls this inside its
    /// grace window; a league that was not never does, and its members are
    /// released automatically. **Doing nothing returns the money.**
    ///
    /// ## The window is the whole safety argument
    ///
    /// This is illegal from exactly the instant the failed-league refund becomes
    /// legal, so the two can never both be available. A league therefore cannot
    /// be started with a partly-drained vault, and a member cannot be refunded
    /// out of a season that has begun — the halves are complements rather than
    /// two checks that have to agree with each other.
    ///
    /// ## What it cannot do
    ///
    /// It changes no term, moves no token, and names no winner. Its only effect
    /// is which of two refund schedules the members are on, and both of those
    /// end with the member holding their own money. `drawDraftOrder` refuses to
    /// draw a pot league until this has landed, which is what stops a
    /// commissioner running a season with the escape hatch still open.
    ///
    /// Free leagues are excluded rather than exempted: no vault, so nothing to
    /// release and nothing to protect.
    pub fn start_season(ctx: Context<StartSeason>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let league = &mut ctx.accounts.league;

        require!(league.has_pot, EscrowError::LeagueHasNoPot);
        require!(!league.started, EscrowError::AlreadyStarted);
        require!(now < league.start_deadline, EscrowError::StartWindowClosed);

        league.started = true;

        Ok(())
    }

    /// Anchor the rules of a league that plays for nothing.
    ///
    /// A free league has no vault, no buy-in, and no payout — but its rule set
    /// is hashed on-chain exactly like a pot league's, and members accept it the
    /// same way through `join_league`. That is the point: "the rules are
    /// immutable and you can verify them" has to be true of every league, not
    /// only the ones with money in them. Otherwise a free league's guarantee is
    /// our database, which is the thing this project exists not to ask anyone to
    /// trust.
    ///
    /// Separate from `initialize_league` rather than a flag on it because the
    /// account set genuinely differs: there is no mint and no vault to create,
    /// and making them optional would mean a caller could pass `None` to a pot
    /// league and get a league that can never take a deposit.
    pub fn initialize_free_league(
        ctx: Context<InitializeFreeLeague>,
        args: InitializeFreeLeagueArgs,
    ) -> Result<()> {
        require!(args.rules_hash != [0u8; 32], EscrowError::RulesHashMissing);
        require!(args.max_teams >= MIN_TEAMS, EscrowError::LeagueTooSmall);
        require!(
            args.max_teams <= MAX_TEAMS_PER_LEAGUE,
            EscrowError::LeagueTooLarge
        );

        let league = &mut ctx.accounts.league;
        league.league_id = args.league_id;
        league.rules_hash = args.rules_hash;
        // No token, no stake, no split, no fee, and no refund date — there is
        // nothing to denominate, divide, charge, or return.
        league.token_mint = Pubkey::default();
        league.buy_in = 0;
        league.refund_unlock_at = 0;
        league.payout_bps = [0; PRIZE_COUNT];
        league.fee_bps = 0;
        league.fee_recipient = Pubkey::default();
        league.has_pot = false;
        league.max_teams = args.max_teams;
        league.member_count = 0;
        league.total_deposited = 0;
        league.bump = ctx.bumps.league;
        // Recorded for symmetry, and it grants nothing here: `start_season`
        // refuses a league with no pot, so this key has no instruction to call.
        league.commissioner = ctx.accounts.payer.key();
        // No start deadline and never started. Both are about releasing a vault
        // and a free league has none, so they are inert rather than defaulted —
        // `refund_stake` cannot run against this league at all.
        league.start_deadline = 0;
        league.started = false;

        Ok(())
    }

    /// Join a league by accepting its rules hash.
    ///
    /// The caller passes the hash **they** believe they are agreeing to, and
    /// the program requires it to equal the league's. That is what makes
    /// consent provable rather than asserted: a client that displayed one rule
    /// set cannot enrol someone under another, because the signature is over a
    /// transaction naming the hash. A boolean "I agree" would prove only that
    /// somebody clicked something.
    pub fn join_league(ctx: Context<JoinLeague>, rules_hash: [u8; 32]) -> Result<()> {
        require!(
            rules_hash == ctx.accounts.league.rules_hash,
            EscrowError::RulesHashMismatch
        );

        let league = &mut ctx.accounts.league;

        // **There is deliberately no seat check here.** See `League::max_teams`.
        //
        // Saturating, where this used to be checked. The old comment argued that
        // checked was right because "at the cap this is unreachable, and if it
        // ever were reachable, silently staying at the maximum would admit an
        // extra member" — sound reasoning that depended entirely on the cap
        // above it. Without the cap it inverts: `member_count` is a `u8`, so
        // `checked_add` starts failing at 255 and 255 throwaway accounts —
        // roughly a quarter of a SOL — would brick the league exactly as the
        // seat cap did. Saturating cannot admit an extra member because it no
        // longer decides admission.
        league.member_count = league.member_count.saturating_add(1);

        let membership = &mut ctx.accounts.membership;
        membership.league = league.key();
        membership.member = ctx.accounts.member.key();
        membership.deposited = 0;
        membership.refunded = false;
        membership.bump = ctx.bumps.membership;

        Ok(())
    }

    /// Stake the buy-in.
    ///
    /// Takes no amount. The figure is `league.buy_in` and nothing else, so
    /// "everyone deposits the identical amount" (docs/RULES.md § 7) is
    /// structural rather than a check that could be reordered away. A member
    /// who wants to stake more has no instruction that lets them.
    pub fn deposit(ctx: Context<Deposit>) -> Result<()> {
        // A free league has no vault to deposit into. Checked explicitly rather
        // than relying on `buy_in == 0` transferring nothing, because a
        // zero-amount transfer would "succeed" and record a deposit that never
        // happened.
        require!(ctx.accounts.league.has_pot, EscrowError::LeagueHasNoPot);

        require!(
            ctx.accounts.membership.deposited == 0,
            EscrowError::AlreadyDeposited
        );
        // Refunding and then re-depositing would let someone re-enter a league
        // after the timelock has already released them.
        require!(
            !ctx.accounts.membership.refunded,
            EscrowError::AlreadyRefunded
        );

        let amount = ctx.accounts.league.buy_in;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.member_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.member.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.membership.deposited = amount;
        ctx.accounts.league.total_deposited = ctx
            .accounts
            .league
            .total_deposited
            .checked_add(amount)
            .ok_or(EscrowError::MathOverflow)?;

        Ok(())
    }

    /// Withdraw your own stake, unconditionally, once the timelock has passed.
    ///
    /// **This is the instruction that makes the rest safe to ship**, and the
    /// reason docs/BUILD-PLAN.md § D5 says to write it first. It turns "the
    /// funds are gone" into "the funds are locked until a date", whatever else
    /// in this program is broken, unfinished, or never written.
    ///
    /// So its conditions are deliberately minimal: the clock has passed, you
    /// deposited, you have not already been refunded. It does not consult
    /// league state, member count, settlement, or abandonment. **Every
    /// additional condition here is a new way for money to become permanently
    /// stuck** — which is precisely the failure this exists to make impossible.
    /// Do not add one.
    pub fn refund_stake(ctx: Context<RefundStake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let league = &ctx.accounts.league;

        // **Two ways in, and this is a disjunction rather than a new condition.**
        //
        // Every extra *condition* on this instruction is a new way for money to
        // become permanently stuck, which is why it has three and no more. This
        // adds none: it can only ever make a refund available earlier, so no
        // path that worked before stops working.
        //
        // The second opening exists because the reasoning behind the first does
        // not apply to a league that never started. The timelock is late so that
        // a refund and a payout can never both be legal — but a league with no
        // season has no payout to race, no scores, nothing to settle. Holding
        // its members' money for six months protects nobody from anything.
        let timelock_open = now >= league.refund_unlock_at;
        let failed_open = !league.started && now >= league.start_deadline;
        require!(timelock_open || failed_open, EscrowError::RefundLocked);

        let amount = ctx.accounts.membership.deposited;
        require!(amount > 0, EscrowError::NothingDeposited);
        require!(
            !ctx.accounts.membership.refunded,
            EscrowError::AlreadyRefunded
        );

        // The vault's authority is the league PDA, so the program signs for it.
        let league_id = ctx.accounts.league.league_id;
        let league_bump = ctx.accounts.league.bump;
        let seeds: &[&[u8]] = &[b"league", league_id.as_ref(), &[league_bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.member_token_account.to_account_info(),
                    authority: ctx.accounts.league.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        // Marked before anything else could re-enter. `deposited` is left as the
        // historical record; `refunded` is what gates a second withdrawal.
        ctx.accounts.membership.refunded = true;
        ctx.accounts.league.total_deposited = ctx
            .accounts
            .league
            .total_deposited
            .checked_sub(amount)
            .ok_or(EscrowError::MathOverflow)?;

        Ok(())
    }
}

/// The terms of a league, frozen at creation.
///
/// **No term may change, and there is no authority that could change one.** That
/// is what docs/DECISIONS.md § "Commissioner powers are bounded by the contract"
/// asks for, and it still holds: the buy-in, the fee, its recipient, the payout
/// split, the mint and the refund date are written once and read forever.
///
/// This paragraph used to say the account had no authority field at all. It has
/// one — `commissioner`, whose sole power is `start_season`, and whose sole
/// effect is which of two refund schedules a member is on. Both end with them
/// holding their own money. See the field for why that was the least bad way to
/// let a league that never started give the money back.
#[account]
#[derive(InitSpace)]
pub struct League {
    /// The league's UUID in Postgres, raw bytes. Also the PDA seed, so the
    /// off-chain record and the on-chain one address each other with no lookup
    /// table in between.
    pub league_id: [u8; 16],
    /// SHA-256 of the canonically encoded rule set. The whole trust model.
    pub rules_hash: [u8; 32],
    /// One token per league. Mixed pots are not a pot — docs/RULES.md § 7.
    pub token_mint: Pubkey,
    /// Buy-in in the token's base units. Every member deposits exactly this.
    pub buy_in: u64,
    /// Unix seconds after which any member may withdraw their own stake
    /// unilaterally, whatever else is broken or unbuilt.
    pub refund_unlock_at: i64,
    /// Payout split in basis points, indexed by [`prize`]. Sums to 10000 for a
    /// pot league; all zeroes for a free one.
    pub payout_bps: [u16; PRIZE_COUNT],
    /// Protocol fee in basis points, taken once at settlement from the pot,
    /// before the payout split is applied.
    ///
    /// Frozen here with everything else, and part of the hashed rule set members
    /// sign — a fee we could change after the fact would make the immutability
    /// claim untrue of the one party with the most to gain from breaking it.
    /// **Never charged on a timelock refund**; see [`rostr_escrow::refund_stake`].
    pub fee_bps: u16,
    /// Where the fee is paid at settlement. `default()` when `fee_bps` is zero.
    pub fee_recipient: Pubkey,
    /// False for a league that plays for nothing: no vault, no deposits, but its
    /// rules hash is anchored here exactly like a pot league's.
    pub has_pot: bool,
    // ---------------------------------------------------------------------
    // `//` and not `///` from here down, deliberately.
    //
    // Anchor compiles a `///` doc comment on a field into the IDL, so writing
    // one is editing build output that `pnpm idl:check` compares byte for byte
    // — and regenerating it needs `anchor build`, which needs a Rust toolchain.
    // Documenting a field from a machine without one turns CI red for a reason
    // that looks nothing like documentation. It cost a round trip here.
    //
    // Short `///` docs elsewhere in this struct predate that and are already in
    // the committed IDL; leave them. New long-form rationale goes in `//`.
    // ---------------------------------------------------------------------
    // The league's declared size, **published and not enforced**.
    //
    // It is part of the terms `anchorTermMismatches` compares against the signed
    // rules, so a creator still cannot anchor a size nobody agreed to. What it
    // no longer does is refuse a `join_league`.
    //
    // That check was removed because it guarded a guest list it cannot read.
    // Being *in a league* is a Postgres fact — a team, a roster, a draft slot —
    // and this program has no view of it; a `Membership` here means "this wallet
    // has a stake", which is a different thing. So the check could only ever
    // hand seats out first-come to anyone on the internet, while the real roster
    // was decided somewhere it could not see. `joinLeague` in `@rostr/db`
    // enforces the size against the actual roster, and always did.
    //
    // Meanwhile it cost about **0.011 SOL to brick a twelve-seat league
    // permanently** (issue #18): claim every seat with throwaway keypairs, and
    // since no instruction closes a `Membership` or decrements `member_count`,
    // the seats never come back. Not even `refund_stake` releases one. The only
    // remedy was recreating the league under a new UUID.
    //
    // **Do not restore the check.** An eviction instruction was considered and
    // is weaker: it can only clear seats that were never funded, so an attacker
    // who deposits still blocks the league and merely pays for the privilege
    // with money they get back at the timelock.
    pub max_teams: u8,
    // How many stakes have ever been opened. **Descriptive, not a limit.**
    //
    // Saturates at 255 rather than erroring — see `join_league`. Nothing reads
    // it to make a decision, so a count that stops climbing is a wrong number
    // on a dashboard rather than a wrong outcome.
    pub member_count: u8,
    /// Running total of live deposits, in base units. Decreases on refund, so
    /// it tracks what the vault actually holds rather than what it ever held.
    pub total_deposited: u64,
    pub bump: u8,
    // ---------------------------------------------------------------------
    // Appended, and appended deliberately. Field order is the serialisation
    // layout, so inserting above would move every field below it and make every
    // already-anchored league unreadable. Same discipline as `EscrowError`.
    // ---------------------------------------------------------------------
    // The wallet that created this league.
    //
    // **This is an authority, and this account did not have one.** The struct
    // docstring above used to say so flatly. What it can do is call
    // `start_season`, whose entire effect is to choose between two refund
    // schedules — and both of them end with the member holding their own money.
    // It cannot change a term, cannot move a token, and cannot name a winner.
    //
    // Its worst abuse is marking a failed league started, which locks stakes
    // until the ordinary timelock: exactly the behaviour before this field
    // existed, so it is not a regression but the floor it was measured against.
    // The commissioner is also a member with a stake, so it costs them too.
    //
    // The alternative was a permissionless `start_season` proving on-chain that
    // the field was full and funded. Rejected: `join_league` is permissionless
    // (#18), so any stranger opening an unfunded `Membership` could force every
    // pot league to fail. Money would stay safe, but a one-transaction kill on
    // any league is worse than an authority whose worst case is the status quo.
    pub commissioner: Pubkey,
    // The instant by which this league must have declared itself started. After
    // it, a league that never did releases every stake.
    //
    // **An explicit instant rather than the draft time plus a constant here**,
    // for the same reason `refund_unlock_at` is: the program has no schedule and
    // no view of a league's calendar, so a deadline it computed itself would be
    // computed from something it was handed anyway. Derived off-chain by
    // `startDeadlineFor` in `@rostr/escrow` as the draft time plus its grace,
    // and compared against the signed rule set by `anchorTermMismatches` — so a
    // creator cannot anchor a deadline nobody agreed to, exactly as they cannot
    // anchor a buy-in or a refund date nobody agreed to.
    //
    // Zero for a free league, which has no vault and so nothing to release.
    pub start_deadline: i64,
    // Set once by `start_season` and never unset. False means the season never
    // began, which is what opens the failed-league refund.
    pub started: bool,
}

/// One member's place in one league.
///
/// Its existence *is* the consent record: it can only be created by
/// `join_league`, which requires a matching rules hash.
#[account]
#[derive(InitSpace)]
pub struct Membership {
    pub league: Pubkey,
    pub member: Pubkey,
    /// Base units staked. Zero until `deposit`.
    pub deposited: u64,
    /// Set once the stake has been withdrawn under the timelock.
    pub refunded: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeLeagueArgs {
    pub league_id: [u8; 16],
    pub rules_hash: [u8; 32],
    pub buy_in: u64,
    pub refund_unlock_at: i64,
    pub payout_bps: [u16; PRIZE_COUNT],
    pub fee_bps: u16,
    pub fee_recipient: Pubkey,
    pub max_teams: u8,
    /// When the season must be declared started by. Appended, so the argument
    /// order is stable. See the field on `League`.
    pub start_deadline: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeFreeLeagueArgs {
    pub league_id: [u8; 16],
    pub rules_hash: [u8; 32],
    pub max_teams: u8,
}

#[derive(Accounts)]
#[instruction(args: InitializeLeagueArgs)]
pub struct InitializeLeague<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + League::INIT_SPACE,
        seeds = [b"league", args.league_id.as_ref()],
        bump,
    )]
    pub league: Account<'info, League>,

    pub mint: Account<'info, Mint>,

    /// The pot. A PDA token account whose authority is the league PDA, so no
    /// key held by any person can move what is in it — only this program can,
    /// and only through the instructions below.
    #[account(
        init,
        payer = payer,
        seeds = [b"vault", league.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = league,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Pays rent, and is recorded as `league.commissioner`.
    ///
    /// This used to say the key held no privileges afterwards and was not
    /// recorded. It is now recorded, and it holds exactly one: `start_season`.
    /// That instruction changes no term and moves no token — see the field.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: InitializeFreeLeagueArgs)]
pub struct InitializeFreeLeague<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + League::INIT_SPACE,
        seeds = [b"league", args.league_id.as_ref()],
        bump,
    )]
    pub league: Account<'info, League>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartSeason<'info> {
    #[account(
        mut,
        seeds = [b"league", league.league_id.as_ref()],
        bump = league.bump,
        // The one authority on this account, checked here rather than in the
        // handler so a caller who is not the commissioner cannot even reach it.
        constraint = league.commissioner == commissioner.key() @ EscrowError::NotCommissioner,
    )]
    pub league: Account<'info, League>,

    /// The wallet that created the league. No other key can start a season, and
    /// this one can do nothing else.
    pub commissioner: Signer<'info>,
}

#[derive(Accounts)]
pub struct JoinLeague<'info> {
    #[account(mut, seeds = [b"league", league.league_id.as_ref()], bump = league.bump)]
    pub league: Account<'info, League>,

    /// Seeded by league and member, so one member cannot hold two places in the
    /// same league: the second `join_league` collides with an existing account
    /// rather than needing a check that could be forgotten.
    #[account(
        init,
        payer = member,
        space = 8 + Membership::INIT_SPACE,
        seeds = [b"membership", league.key().as_ref(), member.key().as_ref()],
        bump,
    )]
    pub membership: Account<'info, Membership>,

    #[account(mut)]
    pub member: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"league", league.league_id.as_ref()], bump = league.bump)]
    pub league: Account<'info, League>,

    #[account(
        mut,
        seeds = [b"membership", league.key().as_ref(), member.key().as_ref()],
        bump = membership.bump,
        // Belt and braces: the seeds already bind these, but a mismatch here
        // would mean crediting one member's stake to another's record.
        constraint = membership.league == league.key() @ EscrowError::MembershipLeagueMismatch,
        constraint = membership.member == member.key() @ EscrowError::MembershipMemberMismatch,
    )]
    pub membership: Account<'info, Membership>,

    #[account(
        mut,
        seeds = [b"vault", league.key().as_ref()],
        bump,
        token::mint = league.token_mint,
        token::authority = league,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The member's own token account. Constraining the mint here is what
    /// BUILD-PLAN calls rejecting mixed tokens "at the type level": a deposit in
    /// the wrong token fails account resolution before any handler runs.
    #[account(
        mut,
        constraint = member_token_account.mint == league.token_mint @ EscrowError::WrongMint,
        constraint = member_token_account.owner == member.key() @ EscrowError::NotTokenOwner,
    )]
    pub member_token_account: Account<'info, TokenAccount>,

    pub member: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundStake<'info> {
    #[account(mut, seeds = [b"league", league.league_id.as_ref()], bump = league.bump)]
    pub league: Account<'info, League>,

    #[account(
        mut,
        seeds = [b"membership", league.key().as_ref(), member.key().as_ref()],
        bump = membership.bump,
        constraint = membership.league == league.key() @ EscrowError::MembershipLeagueMismatch,
        constraint = membership.member == member.key() @ EscrowError::MembershipMemberMismatch,
    )]
    pub membership: Account<'info, Membership>,

    #[account(
        mut,
        seeds = [b"vault", league.key().as_ref()],
        bump,
        token::mint = league.token_mint,
        token::authority = league,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = member_token_account.mint == league.token_mint @ EscrowError::WrongMint,
        constraint = member_token_account.owner == member.key() @ EscrowError::NotTokenOwner,
    )]
    pub member_token_account: Account<'info, TokenAccount>,

    /// Only the member themselves. A refund is not something anyone else may
    /// trigger on their behalf, however well-meant.
    pub member: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum EscrowError {
    #[msg("Rules hash is all zeroes; a league cannot take money without rules")]
    RulesHashMissing,
    #[msg("A pot league needs a buy-in; use initialize_free_league to play for nothing")]
    BuyInZero,
    #[msg("Buy-in is below the minimum a pot is worth escrowing")]
    BuyInBelowMinimum,
    #[msg("Buy-in exceeds the cap for an unaudited escrow")]
    BuyInAboveCap,
    #[msg("A league needs at least two teams")]
    LeagueTooSmall,
    #[msg("Payout shares must sum to exactly 10000 basis points")]
    PayoutNotWhole,
    #[msg("The champion's share must be strictly the largest")]
    ChampionNotLargest,
    #[msg("Refund unlock time must be in the future")]
    RefundUnlockNotInFuture,
    #[msg("Accepted rules hash does not match the league's")]
    RulesHashMismatch,
    // **No longer raised.** Kept because error codes are positional: deleting a
    // variant renumbers every one below it, which silently changes what a
    // deployed client reports for four other failures, and it would move the
    // committed IDL that `idl:check` compares. Seat limits are enforced in
    // Postgres — see `League::max_teams`.
    #[msg("The league already has its full complement of teams")]
    LeagueFull,
    #[msg("This member has already staked their buy-in")]
    AlreadyDeposited,
    #[msg("This stake has already been refunded")]
    AlreadyRefunded,
    #[msg("Nothing was staked, so there is nothing to refund")]
    NothingDeposited,
    #[msg("The refund timelock has not passed yet")]
    RefundLocked,
    #[msg("Token account is for a different mint than the league's pot")]
    WrongMint,
    #[msg("Token account is not owned by the member")]
    NotTokenOwner,
    #[msg("Membership does not belong to this league")]
    MembershipLeagueMismatch,
    #[msg("Membership does not belong to this member")]
    MembershipMemberMismatch,
    #[msg("Pot tokens must have exactly six decimals")]
    UnsupportedMintDecimals,
    #[msg("Protocol fee is above the on-chain ceiling")]
    FeeAboveCeiling,
    #[msg("A non-zero fee requires a recipient")]
    FeeRecipientMissing,
    #[msg("This league plays for nothing and has no vault")]
    LeagueHasNoPot,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    // Appended last on purpose. Error codes are positional, so inserting a
    // variant renumbers every one below it and silently changes what a deployed
    // client reports for unrelated failures.
    //
    // `//` and not `///`: doc comments on error variants are compiled into the
    // IDL, which `idl:check` compares byte for byte, and this machine has no
    // Rust toolchain to regenerate it with.
    #[msg("Refund unlock time is too far in the future")]
    RefundUnlockTooFar,
    #[msg("Only the wallet that created this league may start its season")]
    NotCommissioner,
    #[msg("This league's season has already started")]
    AlreadyStarted,
    #[msg("The window to start this season has closed; its members may now be refunded")]
    StartWindowClosed,
    #[msg("The start deadline must be in the future")]
    StartDeadlineNotInFuture,
    #[msg("The start deadline must fall before the refund unlock")]
    StartDeadlineAfterRefundUnlock,
    // Appended, like everything above it — the discriminants are wire values a
    // client maps back to a name, so appending is safe and renumbering is not.
    #[msg("A league may have at most twelve teams; above that it could never be settled")]
    LeagueTooLarge,
    // ---------------------------------------------------------------------
    // The derivation kernels' refusals — `derive.rs` and `bracket.rs`. They live
    // here, in the one error enum, and that is not a stylistic choice.
    //
    // **Anchor emits exactly one `#[error_code]` enum into the IDL.** A second
    // one does not sit alongside the first, it silently *replaces* it. When
    // `bracket.rs` landed on 2026-08-17 with `DeriveError` still separate,
    // `pnpm idl:sync` rewrote codes 6000-6007 from `RulesHashMissing`,
    // `BuyInZero` and the rest of the escrow errors into `NoTiebreakers` and
    // friends — no warning, green build, and every client mapping a code back to
    // a name wrong about every refusal the program can actually return.
    //
    // `derive.rs` re-exports this as `DeriveError` so the use sites still read
    // as the derivation's own refusals. See the comment there.
    // ---------------------------------------------------------------------
    #[msg("Seeding requires at least one tiebreaker")]
    NoTiebreakers,
    #[msg("Tiebreakers were exhausted with teams still tied; the chain must end in a deterministic one")]
    TiebreakersExhausted,
    #[msg("A result names a team that is not in this league")]
    UnknownTeam,
    #[msg("Unknown tiebreaker discriminant")]
    UnknownTiebreaker,
    #[msg("More teams than this program can settle")]
    TooManyTeams,
    #[msg("Two results occupy the same week and team")]
    MalformedSchedule,
    #[msg("A bracket needs at least two teams and fewer byes than teams")]
    FieldTooSmall,
    #[msg("This field needs more weeks than the bracket window has")]
    NotEnoughWeeks,
    #[msg("The playoff ladder reached a state it should not be able to reach")]
    BracketInvariant,
}
