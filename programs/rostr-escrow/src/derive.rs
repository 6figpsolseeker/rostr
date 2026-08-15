//! Seeding a league, on-chain.
//!
//! `docs/RULES.md` § 7 says the contract *derives* the champion rather than
//! being told who won, and issue #28 is what that costs. This module is the
//! first half of it: records, tiebreakers, and the seed order they produce.
//!
//! ## Why a second implementation exists at all
//!
//! `computeStandings` in `@rostr/core` already does this, and it decides money —
//! seed 1 takes the regular-season prize. Settlement cannot call TypeScript, so
//! the same rule has to exist twice.
//!
//! **Two implementations of one rule is the single failure on this path that
//! pays the wrong person while every test is green.** A wrong score is
//! detectable by anyone holding a box score. A tiebreaker here that splits a
//! two-way tie the other way is silent, permanent, and looks healthy.
//!
//! So neither side is the authority: `standings-corpus.json` is, it is
//! *generated* by running the TypeScript, and both consume it. The tests at the
//! bottom of this file are that corpus. If they fail, this file is wrong — the
//! corpus is the spec and TypeScript is what produces it.
//!
//! ## Shape, and why it is not the obvious one
//!
//! Fixed-size arrays throughout, no `Vec`, no recursion, and groups carried as
//! `u16` bitmasks. That is not premature optimisation, it is what the target
//! requires: the BPF stack frame is a fixed 4 KB and does not grow, so the
//! recursive `orderGroup` this mirrors cannot be transliterated. PR #31 hit the
//! same wall and split instructions to get under it.
//!
//! A bitmask loses ordering, which would normally break the stable sort the
//! TypeScript relies on. It is safe here for a specific reason: every group this
//! produces is in ascending team-index order, and a stable sort by score leaves
//! equal scores in that order, so iterating set bits low-to-high *recovers* the
//! order rather than guessing at it. The one place that stops being true is
//! `LOWEST_TEAM_ID`, which sorts by id and returns without recursing.

use anchor_lang::prelude::*;

/// The most teams a league may have for settlement to be derivable.
///
/// `docs/RULES.md` § 3 caps a league at twelve; this leaves headroom without
/// letting the account layouts grow. Nothing enforces it yet — the check
/// belongs at `initialize_league` and lands with the accounts that need it.
pub const MAX_TEAMS: usize = 16;

/// Regular-season weeks a league may have. Sized to the NFL, with room.
pub const MAX_WEEKS: usize = 18;

/// Mirrors `Tiebreaker` in `packages/core/src/rules/types.ts`.
///
/// The discriminants are wire values: they will be frozen into `League` at
/// creation and compared against the signed rule set, so **the numbers may not
/// be reordered** once a league exists. Appending is safe; renumbering is not.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Tiebreaker {
    WinPct = 0,
    PointsFor = 1,
    HeadToHead = 2,
    PointsAgainst = 3,
    LowestTeamId = 4,
}

impl Tiebreaker {
    /// Parse a stored discriminant. Unknown values are refused rather than
    /// defaulted — a tiebreaker nobody recognises must not silently become
    /// "win percentage".
    pub fn from_u8(value: u8) -> Result<Self> {
        Ok(match value {
            0 => Tiebreaker::WinPct,
            1 => Tiebreaker::PointsFor,
            2 => Tiebreaker::HeadToHead,
            3 => Tiebreaker::PointsAgainst,
            4 => Tiebreaker::LowestTeamId,
            _ => return err!(DeriveError::UnknownTiebreaker),
        })
    }
}

#[error_code]
pub enum DeriveError {
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
}

/// One completed game. A bye is represented by `away == None` and counts for
/// nothing at all — not a game, not a point, not a record.
#[derive(Clone, Copy, Debug)]
pub struct GameResult {
    pub home: u8,
    /// `None` on a bye.
    pub away: Option<u8>,
    pub home_milli_points: u32,
    pub away_milli_points: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TeamRecord {
    pub wins: u16,
    pub losses: u16,
    pub ties: u16,
    pub milli_points_for: u64,
    pub milli_points_against: u64,
    /// Games played, excluding byes, so win percentage stays comparable.
    pub games: u16,
}

/// Win percentage in basis points, with a tie worth half a win.
///
/// **Half-up, in integers.** The TypeScript is `Math.round(n / d)`, which rounds
/// half away from zero; the values here are non-negative, so that is half-up.
/// `(n + d/2) / d` with `d = games * 2` gives `(n + games) / (games * 2)` — and
/// `d/2` is exact because `d` is even by construction.
///
/// The `+ games` is the whole of it, and it is easy to drop as noise. A 0-2-1
/// record is `1 * 10000 / 6` = 1666.67: half-up gives 1667, truncation gives
/// 1666. Two things catch it: `win_percentage_rounds_half_up` below, and the
/// corpus — which records the percentage itself for exactly this reason, since
/// no *ordering* can expose it (see that test).
pub fn win_percentage_basis_points(record: &TeamRecord) -> u32 {
    if record.games == 0 {
        return 0;
    }
    let numerator = (record.wins as u64 * 2 + record.ties as u64) * 10_000;
    let denominator = record.games as u64 * 2;
    ((numerator + record.games as u64) / denominator) as u32
}

/// Tally records from completed games.
///
/// Refuses a result naming a team outside the league rather than skipping it:
/// silently ignoring the row would drop a real game from everyone's record and
/// change the seeding with nothing to show for it.
pub fn compute_records(
    team_count: usize,
    results: &[GameResult],
) -> Result<[TeamRecord; MAX_TEAMS]> {
    require!(team_count <= MAX_TEAMS, DeriveError::TooManyTeams);

    let mut records = [TeamRecord::default(); MAX_TEAMS];

    for result in results {
        let home = result.home as usize;
        require!(home < team_count, DeriveError::UnknownTeam);

        // A bye is not a game.
        let Some(away_index) = result.away else {
            continue;
        };
        let away = away_index as usize;
        require!(away < team_count, DeriveError::UnknownTeam);

        records[home].milli_points_for += result.home_milli_points as u64;
        records[home].milli_points_against += result.away_milli_points as u64;
        records[away].milli_points_for += result.away_milli_points as u64;
        records[away].milli_points_against += result.home_milli_points as u64;
        records[home].games += 1;
        records[away].games += 1;

        if result.home_milli_points > result.away_milli_points {
            records[home].wins += 1;
            records[away].losses += 1;
        } else if result.home_milli_points < result.away_milli_points {
            records[away].wins += 1;
            records[home].losses += 1;
        } else {
            // Vanishingly rare at milli-point resolution, and a league with
            // money in it cannot have an undefined case.
            records[home].ties += 1;
            records[away].ties += 1;
        }
    }

    Ok(records)
}

/// One team's place in the final order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seed {
    /// Index into the caller's team array.
    pub team: u8,
    /// Which link separated this team from the one above it, if any.
    pub decided_by: Option<Tiebreaker>,
}

/// Head-to-head win percentage within a tied group, or `None` when it does not
/// apply.
///
/// It does not apply unless **every pair in the group met, and met the same
/// number of times**. Comparing records against each other otherwise compares
/// different schedules, and the tiebreaker is skipped whole rather than applied
/// unevenly — which is what every platform does and what the TypeScript does.
fn head_to_head_scores(mask: u16, results: &[GameResult], out: &mut [i64; MAX_TEAMS]) -> bool {
    let size = mask.count_ones() as usize;
    if size < 2 {
        return false;
    }

    let mut wins = [0u16; MAX_TEAMS];
    let mut ties = [0u16; MAX_TEAMS];
    let mut games = [0u16; MAX_TEAMS];
    let mut meetings = [[0u16; MAX_TEAMS]; MAX_TEAMS];

    for result in results {
        let Some(away_index) = result.away else {
            continue;
        };
        let home = result.home as usize;
        let away = away_index as usize;
        if mask & (1 << home) == 0 || mask & (1 << away) == 0 {
            continue;
        }

        games[home] += 1;
        games[away] += 1;
        meetings[home.min(away)][home.max(away)] += 1;

        if result.home_milli_points > result.away_milli_points {
            wins[home] += 1;
        } else if result.home_milli_points < result.away_milli_points {
            wins[away] += 1;
        } else {
            ties[home] += 1;
            ties[away] += 1;
        }
    }

    // Every pair must have met, and met equally often.
    let mut met_pairs = 0usize;
    let mut fewest = u16::MAX;
    let mut most = 0u16;
    for a in 0..MAX_TEAMS {
        if mask & (1 << a) == 0 {
            continue;
        }
        for b in (a + 1)..MAX_TEAMS {
            if mask & (1 << b) == 0 {
                continue;
            }
            let count = meetings[a][b];
            if count > 0 {
                met_pairs += 1;
                fewest = fewest.min(count);
                most = most.max(count);
            }
        }
    }

    let expected_pairs = size * (size - 1) / 2;
    if met_pairs != expected_pairs || fewest != most {
        return false;
    }

    for team in 0..MAX_TEAMS {
        if mask & (1 << team) == 0 {
            continue;
        }
        out[team] = if games[team] == 0 {
            0
        } else {
            let numerator = (wins[team] as u64 * 2 + ties[team] as u64) * 10_000;
            let denominator = games[team] as u64 * 2;
            ((numerator + games[team] as u64) / denominator) as i64
        };
    }

    true
}

/// A team's score under one tiebreaker. **Higher is always better.**
///
/// Returns `false` when the tiebreaker does not apply to this group, which only
/// head-to-head ever does. `LowestTeamId` is not scored — it is handled where
/// the ordering happens, because it sorts on the id rather than on a number.
fn scores_for(
    tiebreaker: Tiebreaker,
    mask: u16,
    records: &[TeamRecord; MAX_TEAMS],
    results: &[GameResult],
    out: &mut [i64; MAX_TEAMS],
) -> bool {
    match tiebreaker {
        Tiebreaker::WinPct => {
            for team in 0..MAX_TEAMS {
                if mask & (1 << team) != 0 {
                    out[team] = win_percentage_basis_points(&records[team]) as i64;
                }
            }
            true
        }
        Tiebreaker::PointsFor => {
            for team in 0..MAX_TEAMS {
                if mask & (1 << team) != 0 {
                    out[team] = records[team].milli_points_for as i64;
                }
            }
            true
        }
        Tiebreaker::PointsAgainst => {
            // Negated, because fewer points allowed is better and "higher is
            // better" has to hold for every link or the ordering silently
            // inverts one of them.
            for team in 0..MAX_TEAMS {
                if mask & (1 << team) != 0 {
                    out[team] = -(records[team].milli_points_against as i64);
                }
            }
            true
        }
        Tiebreaker::HeadToHead => head_to_head_scores(mask, results, out),
        Tiebreaker::LowestTeamId => false,
    }
}

/// Work still to do: a group of teams, where in the chain to resume, and what
/// separated the group from the one above it.
#[derive(Clone, Copy)]
struct Pending {
    mask: u16,
    from_link: usize,
    decided_by: Option<Tiebreaker>,
}

/// Seed a league, best first.
///
/// `team_ids` are the raw 16-byte ids, in the caller's order; a group that
/// reaches `LowestTeamId` is ordered by comparing those bytes. That agrees with
/// the TypeScript's `localeCompare` **because Postgres ids are canonical
/// lowercase hex** — the corpus asserts that property rather than assuming it.
pub fn compute_standings(
    team_ids: &[[u8; 16]],
    results: &[GameResult],
    tiebreakers: &[Tiebreaker],
) -> Result<([Seed; MAX_TEAMS], usize)> {
    let team_count = team_ids.len();
    require!(team_count <= MAX_TEAMS, DeriveError::TooManyTeams);
    require!(!tiebreakers.is_empty(), DeriveError::NoTiebreakers);

    let records = compute_records(team_count, results)?;

    let mut ordered = [Seed {
        team: 0,
        decided_by: None,
    }; MAX_TEAMS];
    let mut placed = 0usize;

    // Depth-first over groups. Sub-groups are pushed in reverse so the best one
    // pops first, which reproduces the TypeScript's `flatMap` order exactly.
    let mut stack = [Pending {
        mask: 0,
        from_link: 0,
        decided_by: None,
    }; MAX_TEAMS * 2];
    let mut depth = 1usize;
    stack[0] = Pending {
        mask: if team_count == MAX_TEAMS {
            u16::MAX
        } else {
            (1u16 << team_count) - 1
        },
        from_link: 0,
        decided_by: None,
    };

    while depth > 0 {
        depth -= 1;
        let Pending {
            mask,
            from_link,
            decided_by,
        } = stack[depth];

        if mask.count_ones() <= 1 {
            if let Some(team) = (0..MAX_TEAMS).find(|team| mask & (1 << team) != 0) {
                ordered[placed] = Seed {
                    team: team as u8,
                    decided_by,
                };
                placed += 1;
            }
            continue;
        }

        let mut settled = false;

        for link in from_link..tiebreakers.len() {
            let tiebreaker = tiebreakers[link];

            if tiebreaker == Tiebreaker::LowestTeamId {
                // The terminal backstop. Four real criteria have already called
                // these teams indistinguishable, so there is nothing left to be
                // fair about — what is required is that the answer be total,
                // reproducible by anyone holding the published standings, and
                // impossible for a participant to steer.
                let mut members = [0u8; MAX_TEAMS];
                let mut count = 0usize;
                for team in 0..MAX_TEAMS {
                    if mask & (1 << team) != 0 {
                        members[count] = team as u8;
                        count += 1;
                    }
                }
                members[..count]
                    .sort_unstable_by(|a, b| team_ids[*a as usize].cmp(&team_ids[*b as usize]));
                for (position, team) in members[..count].iter().enumerate() {
                    ordered[placed] = Seed {
                        team: *team,
                        decided_by: if position == 0 {
                            decided_by
                        } else {
                            Some(tiebreaker)
                        },
                    };
                    placed += 1;
                }
                settled = true;
                break;
            }

            let mut scores = [0i64; MAX_TEAMS];
            if !scores_for(tiebreaker, mask, &records, results, &mut scores) {
                continue; // Does not apply to this group — head-to-head only.
            }

            // Partition into runs of equal score, best first. Iterating set bits
            // low-to-high keeps ascending team order within a run, which is what
            // the TypeScript's stable sort gives.
            let mut members = [0u8; MAX_TEAMS];
            let mut count = 0usize;
            for team in 0..MAX_TEAMS {
                if mask & (1 << team) != 0 {
                    members[count] = team as u8;
                    count += 1;
                }
            }
            members[..count].sort_by(|a, b| scores[*b as usize].cmp(&scores[*a as usize]));

            let mut buckets = [0u16; MAX_TEAMS];
            let mut bucket_count = 0usize;
            let mut previous: Option<i64> = None;
            for team in &members[..count] {
                let score = scores[*team as usize];
                if Some(score) == previous && bucket_count > 0 {
                    buckets[bucket_count - 1] |= 1 << *team;
                } else {
                    buckets[bucket_count] = 1 << *team;
                    bucket_count += 1;
                }
                previous = Some(score);
            }

            if bucket_count == 1 {
                continue; // Everyone equal; this link decided nothing.
            }

            for position in (0..bucket_count).rev() {
                stack[depth] = Pending {
                    mask: buckets[position],
                    from_link: link + 1,
                    decided_by: if position == 0 {
                        decided_by
                    } else {
                        Some(tiebreaker)
                    },
                };
                depth += 1;
            }
            settled = true;
            break;
        }

        // The chain ran out with teams still tied. Returning the input order
        // would make a seed depend on the order rows came out of a database,
        // silently — so this refuses instead.
        require!(settled, DeriveError::TiebreakersExhausted);
    }

    Ok((ordered, placed))
}

#[cfg(test)]
mod conformance {
    //! The corpus, run against this implementation.
    //!
    //! Every case, its expected order and its expected refusal are **generated**
    //! by running `computeStandings` — see `packages/core/src/season/conformance`.
    //! A failure here means this file disagrees with the TypeScript that decides
    //! what members are shown, and the TypeScript is the spec.

    use super::*;
    use serde::Deserialize;

    const CORPUS: &str =
        include_str!("../../../packages/core/src/season/conformance/standings-corpus.json");

    #[derive(Deserialize)]
    struct Corpus {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        why: String,
        team_ids: Vec<String>,
        results: Vec<RawResult>,
        tiebreakers: Vec<String>,
        #[serde(default)]
        seeds: Option<Vec<RawSeed>>,
        #[serde(default)]
        refusal: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawResult {
        home_team_id: String,
        away_team_id: Option<String>,
        home_milli_points: u32,
        away_milli_points: u32,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawSeed {
        team_id: String,
        wins: u16,
        losses: u16,
        ties: u16,
        milli_points_for: u64,
        milli_points_against: u64,
        games: u16,
        win_pct_basis_points: u32,
        decided_by: Option<String>,
    }

    /// Parse a canonical UUID into the sixteen bytes the program holds.
    fn uuid_bytes(text: &str) -> [u8; 16] {
        let hex: String = text.chars().filter(|c| *c != '-').collect();
        let mut out = [0u8; 16];
        for (index, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                .expect("corpus ids are canonical lowercase hex");
        }
        out
    }

    fn tiebreaker_of(name: &str) -> Tiebreaker {
        match name {
            "WIN_PCT" => Tiebreaker::WinPct,
            "POINTS_FOR" => Tiebreaker::PointsFor,
            "HEAD_TO_HEAD" => Tiebreaker::HeadToHead,
            "POINTS_AGAINST" => Tiebreaker::PointsAgainst,
            "LOWEST_TEAM_ID" => Tiebreaker::LowestTeamId,
            other => panic!("corpus names a tiebreaker this kernel does not have: {other}"),
        }
    }

    /// The corpus records a refusal *code*; the kernel returns an Anchor error.
    /// Mapping them here rather than comparing messages is deliberate — a
    /// message is prose and drifts, a code is the contract.
    fn refusal_matches(code: &str, error: &anchor_lang::error::Error) -> bool {
        let expected: u32 = match code {
            "NO_TIEBREAKERS" => DeriveError::NoTiebreakers.into(),
            "TIEBREAKERS_EXHAUSTED" => DeriveError::TiebreakersExhausted.into(),
            "UNKNOWN_TEAM" => DeriveError::UnknownTeam.into(),
            other => panic!("corpus names a refusal this kernel does not have: {other}"),
        };
        matches!(
            error,
            anchor_lang::error::Error::AnchorError(inner) if inner.error_code_number == expected
        )
    }

    #[test]
    fn matches_the_typescript_on_every_case() {
        let corpus: Corpus = serde_json::from_str(CORPUS).expect("corpus parses");
        assert!(!corpus.cases.is_empty(), "an empty corpus proves nothing");

        for case in &corpus.cases {
            let ids: Vec<[u8; 16]> = case.team_ids.iter().map(|id| uuid_bytes(id)).collect();
            let index_of = |wanted: &str| -> u8 {
                case.team_ids
                    .iter()
                    .position(|id| id == wanted)
                    .map(|position| position as u8)
                    // A result may legitimately name a team outside the league —
                    // that is the UNKNOWN_TEAM case, and it must reach the kernel
                    // as an out-of-range index rather than being caught here.
                    .unwrap_or(u8::MAX)
            };

            let results: Vec<GameResult> = case
                .results
                .iter()
                .map(|raw| GameResult {
                    home: index_of(&raw.home_team_id),
                    away: raw.away_team_id.as_deref().map(index_of),
                    home_milli_points: raw.home_milli_points,
                    away_milli_points: raw.away_milli_points,
                })
                .collect();

            let chain: Vec<Tiebreaker> = case
                .tiebreakers
                .iter()
                .map(|name| tiebreaker_of(name))
                .collect();

            let outcome = compute_standings(&ids, &results, &chain);
            let records =
                compute_records(ids.len(), &results).unwrap_or([TeamRecord::default(); MAX_TEAMS]);

            match (&case.seeds, &case.refusal) {
                (Some(expected), None) => {
                    let (ordered, placed) = outcome.unwrap_or_else(|error| {
                        panic!(
                            "{}\n  why: {}\n  refused unexpectedly: {error}",
                            case.name, case.why
                        )
                    });
                    assert_eq!(
                        placed,
                        expected.len(),
                        "{}\n  why: {}\n  seeded a different number of teams",
                        case.name,
                        case.why
                    );

                    for (position, want) in expected.iter().enumerate() {
                        let got = ordered[position];
                        assert_eq!(
                            case.team_ids[got.team as usize],
                            want.team_id,
                            "{}\n  why: {}\n  seed {} is the wrong team",
                            case.name,
                            case.why,
                            position + 1
                        );

                        // The record and the win percentage, not only the order.
                        // The arithmetic cannot be caught by the ordering — see
                        // `win_percentage_rounds_half_up` — so the corpus carries
                        // the numbers and this is where they bite.
                        let record = &records[got.team as usize];
                        assert_eq!(
                            (
                                record.wins,
                                record.losses,
                                record.ties,
                                record.games,
                                record.milli_points_for,
                                record.milli_points_against,
                                win_percentage_basis_points(record),
                            ),
                            (
                                want.wins,
                                want.losses,
                                want.ties,
                                want.games,
                                want.milli_points_for,
                                want.milli_points_against,
                                want.win_pct_basis_points,
                            ),
                            "{}\n  why: {}\n  seed {} has the wrong record",
                            case.name,
                            case.why,
                            position + 1
                        );

                        let got_decided = got.decided_by.map(|tiebreaker| match tiebreaker {
                            Tiebreaker::WinPct => "WIN_PCT",
                            Tiebreaker::PointsFor => "POINTS_FOR",
                            Tiebreaker::HeadToHead => "HEAD_TO_HEAD",
                            Tiebreaker::PointsAgainst => "POINTS_AGAINST",
                            Tiebreaker::LowestTeamId => "LOWEST_TEAM_ID",
                        });
                        assert_eq!(
                            got_decided,
                            want.decided_by.as_deref(),
                            "{}\n  why: {}\n  seed {} was separated by a different link",
                            case.name,
                            case.why,
                            position + 1
                        );
                    }
                }
                (None, Some(code)) => {
                    let error = outcome.err().unwrap_or_else(|| {
                        panic!(
                            "{}\n  why: {}\n  should have refused with {code}",
                            case.name, case.why
                        )
                    });
                    assert!(
                        refusal_matches(code, &error),
                        "{}\n  why: {}\n  refused with the wrong code: {error}",
                        case.name,
                        case.why
                    );
                }
                _ => panic!(
                    "{}: corpus records neither one outcome nor the other",
                    case.name
                ),
            }
        }
    }

    #[test]
    fn a_tie_is_half_a_win() {
        // Pinned directly as well as through the corpus, because it is the one
        // number in this file that a reader is most likely to "simplify".
        let one_and_one = TeamRecord {
            wins: 1,
            losses: 1,
            games: 2,
            ..Default::default()
        };
        assert_eq!(win_percentage_basis_points(&one_and_one), 5_000);

        let two_ties = TeamRecord {
            ties: 2,
            games: 2,
            ..Default::default()
        };
        assert_eq!(win_percentage_basis_points(&two_ties), 5_000);

        let unplayed = TeamRecord::default();
        assert_eq!(win_percentage_basis_points(&unplayed), 0);
    }

    /// The rounding boundary.
    ///
    /// **No ordering can catch this.** Every win percentage is a multiple of
    /// `5000 / games`, so at league sizes anyone plays there are no two teams
    /// whose true values straddle a half — which is the only way rounding moves
    /// a *seed* rather than a number. Truncating the arithmetic and re-running
    /// the corpus left every seed order identical, which is how that was
    /// established rather than assumed.
    ///
    /// So the corpus records the percentage itself, and this pins the specific
    /// records where half-up and truncation disagree. An earlier version used
    /// 1-in-3, 7/16 and 1-in-12 — all of which round and truncate alike, so it
    /// asserted nothing about its own name and passed against the bug.
    #[test]
    fn win_percentage_rounds_half_up() {
        // 0-2-1 over three games: (0*2 + 1) * 10000 / 6 = 1666.67.
        // Half-up gives 1667; truncation gives 1666.
        let one_tie_in_three = TeamRecord {
            losses: 2,
            ties: 1,
            games: 3,
            ..Default::default()
        };
        assert_eq!(win_percentage_basis_points(&one_tie_in_three), 1_667);

        // 2-1-0 over three games: (2*2) * 10000 / 6 = 6666.67 → 6667, not 6666.
        let two_in_three = TeamRecord {
            wins: 2,
            losses: 1,
            games: 3,
            ..Default::default()
        };
        assert_eq!(win_percentage_basis_points(&two_in_three), 6_667);

        // 2-3-1 over six games: (2*2 + 1) * 10000 / 12 = 4166.67 → 4167.
        let five_twelfths = TeamRecord {
            wins: 2,
            losses: 3,
            ties: 1,
            games: 6,
            ..Default::default()
        };
        assert_eq!(win_percentage_basis_points(&five_twelfths), 4_167);

        // And one that lands exactly, so the `+ games` term is not simply
        // adding one to everything: 1-2-0 over three is 3333.33 → 3333.
        let one_in_three = TeamRecord {
            wins: 1,
            losses: 2,
            games: 3,
            ..Default::default()
        };
        assert_eq!(win_percentage_basis_points(&one_in_three), 3_333);
    }

    #[test]
    fn a_bye_touches_nothing() {
        let results = [GameResult {
            home: 0,
            away: None,
            home_milli_points: 123_000,
            away_milli_points: 0,
        }];
        let records = compute_records(2, &results).expect("a bye is legal");
        assert_eq!(records[0], TeamRecord::default());
        assert_eq!(records[1], TeamRecord::default());
    }
}
