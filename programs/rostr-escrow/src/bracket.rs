//! The playoff ladder, on-chain.
//!
//! `derive.rs` answers who is seeded where. This answers who won, which is the
//! other half of what settlement needs: the champion and the runner-up hold 90%
//! of the default payout between them, and `docs/RULES.md` §7 says the contract
//! derives them from the scores rather than being told.
//!
//! ## Why a second implementation exists at all
//!
//! `buildBracket` in `packages/core/src/season/bracket.ts` already does this, and
//! settlement cannot call TypeScript. The same warning as `derive.rs`: **two
//! implementations of one rule is the single failure on this path that pays the
//! wrong person while every test is green.** A wrong score is detectable by
//! anyone holding a box score. A ladder that reseeds differently is silent.
//!
//! So neither side is the authority. `bracket-corpus.json` is, it is *generated*
//! by running the TypeScript, and both consume it. The tests at the bottom of
//! this file are that corpus.
//!
//! ## Shape
//!
//! Fixed-size arrays, no `Vec`, no recursion, no allocation — the BPF stack
//! frame is a fixed 4 KB and does not grow. Team identity is a `u8` index, as in
//! `derive.rs`, so nothing here holds a UUID or a `Pubkey`.
//!
//! `label` is not implemented. "Semifinal" and "Quarterfinal" render a screen,
//! and a program with no display should not carry display strings to satisfy a
//! conformance test. The corpus deliberately does not pin them.

use anchor_lang::prelude::*;

use crate::derive::{DeriveError, MAX_TEAMS};

/// The most rounds a bracket can need.
///
/// Exactly reachable rather than padded: the widest legal input is sixteen teams
/// with fifteen first-round byes, which resolves in five. See
/// [`rounds_needed`] for the arithmetic.
pub const MAX_BRACKET_ROUNDS: usize = 5;

/// The most games one round can hold: everybody paired, nobody idle.
pub const MAX_GAMES_PER_ROUND: usize = MAX_TEAMS / 2;

/// One played playoff game.
///
/// **A bye is not representable here, deliberately.** `buildBracket` indexes its
/// results and skips any row whose away team is null, so a bye can never be
/// looked up as a game; making it unrepresentable is the same rule enforced one
/// layer earlier. The caller filters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlayoffResult {
    pub week: u8,
    pub home: u8,
    pub away: u8,
    pub home_milli_points: u32,
    pub away_milli_points: u32,
}

/// A team in a bracket, carrying the seed it entered with.
///
/// The seed is fixed at entry and never re-derived — it is the position in the
/// field, not a rank recomputed as teams drop out. Reseeding pairs by this
/// number every round, so a bracket that recomputed it would pair round three
/// against the wrong opponent while looking entirely reasonable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Entrant {
    pub team: u8,
    /// 1-based.
    pub seed: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Game {
    pub week: u8,
    /// 1-based, counting from the first round this bracket plays.
    pub round: u8,
    /// The higher seed, which is the only thing "home" means in a bracket.
    pub home: u8,
    pub away: u8,
    // Carried so third place can pair the losing semifinalists without looking
    // an entrant back up by team id. The TypeScript does that lookup and guards
    // it with an invariant that cannot fire — a winner is always one of the
    // game's own pair — so holding the seeds here removes the guard rather than
    // reimplementing it.
    pub home_seed: u8,
    pub away_seed: u8,
    /// `None` until the game has been scored.
    pub winner: Option<u8>,
    /// True when equal totals sent the higher seed through.
    pub decided_by_seed: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Round {
    pub week: u8,
    pub round: u8,
    pub games: [Game; MAX_GAMES_PER_ROUND],
    pub game_count: usize,
    pub byes: [Entrant; MAX_TEAMS],
    pub bye_count: usize,
    /// Everyone through to the next round. Meaningless unless `resolved`.
    pub survivors: [Entrant; MAX_TEAMS],
    pub survivor_count: usize,
    /// Whether every game in this round has a winner. The TypeScript carries
    /// this as `survivors: null`; a fixed array cannot be null, so the flag says
    /// what the null said.
    pub resolved: bool,
}

impl Default for Round {
    fn default() -> Self {
        Self {
            week: 0,
            round: 0,
            games: [Game::default(); MAX_GAMES_PER_ROUND],
            game_count: 0,
            byes: [Entrant::default(); MAX_TEAMS],
            bye_count: 0,
            survivors: [Entrant::default(); MAX_TEAMS],
            survivor_count: 0,
            resolved: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Bracket {
    pub rounds: [Round; MAX_BRACKET_ROUNDS],
    pub round_count: usize,
    pub champion: Option<u8>,
    pub runner_up: Option<u8>,
    pub third_place_game: Option<Game>,
}

/// Who finished third, or `None` while the game is unplayed.
///
/// Mirrors `thirdPlaceWinner`. Separate from the ladder because third place is a
/// prize rather than a step toward one — nobody advances out of it.
pub fn third_place_winner(bracket: &Bracket) -> Option<u8> {
    bracket.third_place_game.and_then(|game| game.winner)
}

/// The whole bracket, as far as the results reach.
///
/// Rounds beyond the last completed one are not invented: the ladder stops at
/// the first round holding an unscored game, because who plays next genuinely is
/// not known yet. A kernel that padded them would derive a champion from a
/// season that has not finished.
///
/// `field` is in seed order, best first. `weeks` are the weeks this bracket may
/// use, ascending.
pub fn build_bracket(
    field: &[u8],
    weeks: &[u8],
    first_round_byes: usize,
    results: &[PlayoffResult],
    third_place: bool,
) -> Result<Bracket> {
    require!(field.len() >= 2, DeriveError::FieldTooSmall);
    require!(field.len() <= MAX_TEAMS, DeriveError::TooManyTeams);
    // `usize` makes the lower half of the TypeScript's `< 0 || >= length` check
    // unrepresentable; the upper half is the one a plausible implementation gets
    // wrong, and every team sitting out leaves nobody to eliminate.
    require!(first_round_byes < field.len(), DeriveError::FieldTooSmall);

    let round_count = rounds_needed(field.len(), first_round_byes);
    require!(round_count <= weeks.len(), DeriveError::NotEnoughWeeks);
    // Unreachable for any input that got past the checks above — sixteen teams
    // with fifteen byes needs exactly five. Kept because it is the bound the
    // array below is sized to, and an unchecked write past it is the kind of bug
    // that reads as a wrong champion rather than as a crash.
    require!(
        round_count <= MAX_BRACKET_ROUNDS,
        DeriveError::BracketInvariant
    );

    // The bracket plays the *last* weeks of its window, not the first. A field
    // needing fewer rounds than there are weeks must still finish in the
    // championship week, because that is the week the payout settles.
    let weeks = &weeks[weeks.len() - round_count..];

    let mut alive = [Entrant::default(); MAX_TEAMS];
    for (index, team) in field.iter().enumerate() {
        alive[index] = Entrant {
            team: *team,
            seed: (index + 1) as u8,
        };
    }
    let mut alive_count = field.len();

    let mut rounds = [Round::default(); MAX_BRACKET_ROUNDS];
    let mut rounds_built = 0usize;

    for (index, week) in weeks.iter().enumerate() {
        let bye_count = if index == 0 {
            first_round_byes
        } else {
            byes_needed(alive_count)
        };

        let round = pair_round(
            &alive[..alive_count],
            bye_count,
            *week,
            (index + 1) as u8,
            results,
        )?;

        rounds[rounds_built] = round;
        rounds_built += 1;

        if !round.resolved {
            break;
        }

        alive[..round.survivor_count].copy_from_slice(&round.survivors[..round.survivor_count]);
        alive_count = round.survivor_count;
    }

    let last = rounds[rounds_built - 1];
    let decided = rounds_built == weeks.len() && last.resolved && last.survivor_count == 1;

    let champion = if decided {
        Some(last.survivors[0].team)
    } else {
        None
    };
    let runner_up = if decided && last.game_count > 0 {
        loser_of(&last.games[0])
    } else {
        None
    };

    let third_place_game = if third_place {
        build_third_place(&rounds[..rounds_built], round_count, weeks, results)
    } else {
        None
    };

    Ok(Bracket {
        rounds,
        round_count: rounds_built,
        champion,
        runner_up,
        third_place_game,
    })
}

/// One round's games, pairing the best surviving seed against the worst.
///
/// The top `bye_count` seeds sit out. Everyone else is paired highest-with-
/// lowest, which is what makes a bracket reward a good regular season: the prize
/// for seeding first is the weakest opponent still standing.
fn pair_round(
    entrants: &[Entrant],
    bye_count: usize,
    week: u8,
    round: u8,
    results: &[PlayoffResult],
) -> Result<Round> {
    // `alive` is kept in seed order by construction — the field arrives sorted
    // and `survivors` is sorted before it is handed back — so this mirrors the
    // TypeScript's defensive re-sort without repeating it.
    let mut out = Round {
        week,
        round,
        ..Round::default()
    };

    require!(bye_count <= entrants.len(), DeriveError::BracketInvariant);
    let playing = &entrants[bye_count..];
    // A rule set producing an odd count should have been refused at creation, so
    // this is our bug rather than that league's — which is exactly the
    // distinction `BracketInvariant` exists to keep.
    require!(playing.len() % 2 == 0, DeriveError::BracketInvariant);

    out.byes[..bye_count].copy_from_slice(&entrants[..bye_count]);
    out.bye_count = bye_count;

    let games = playing.len() / 2;
    let mut all_scored = true;

    for i in 0..games {
        let home = playing[i];
        let away = playing[playing.len() - 1 - i];
        let result = find_result(results, week, home.team, away.team);

        let (winner, decided_by_seed) = match result {
            Some(played) => {
                let home_points = points_for(&played, home.team);
                let away_points = points_for(&played, away.team);
                (
                    Some(advance(home, away, home_points, away_points)),
                    home_points == away_points,
                )
            }
            None => {
                all_scored = false;
                (None, false)
            }
        };

        out.games[i] = Game {
            week,
            round,
            home: home.team,
            away: away.team,
            home_seed: home.seed,
            away_seed: away.seed,
            winner,
            decided_by_seed,
        };
    }
    out.game_count = games;

    if all_scored {
        let mut survivors = [Entrant::default(); MAX_TEAMS];
        let mut count = 0usize;

        for bye in &out.byes[..bye_count] {
            survivors[count] = *bye;
            count += 1;
        }
        for game in &out.games[..games] {
            // `all_scored` is what makes this unwrap total.
            let winner = game.winner.ok_or(DeriveError::BracketInvariant)?;
            survivors[count] = Entrant {
                team: winner,
                seed: if winner == game.home {
                    game.home_seed
                } else {
                    game.away_seed
                },
            };
            count += 1;
        }

        sort_by_seed(&mut survivors[..count]);
        out.survivors = survivors;
        out.survivor_count = count;
        out.resolved = true;
    }

    Ok(out)
}

/// The two losing semifinalists, in the championship week, higher seed at home.
///
/// The semifinal is found **by round number, not by taking the second-to-last
/// round built**. Those differ exactly when the semifinals are half-scored: the
/// ladder stops there, so the second-to-last round built is the *quarterfinal*,
/// and pairing its losers would invent a third-place game between two teams
/// knocked out a round earlier.
fn build_third_place(
    rounds: &[Round],
    total_rounds: usize,
    weeks: &[u8],
    results: &[PlayoffResult],
) -> Option<Game> {
    if total_rounds < 2 {
        return None;
    }
    let semis = rounds
        .iter()
        .find(|r| r.round as usize == total_rounds - 1)?;
    if semis.game_count != 2 || !semis.resolved {
        return None;
    }
    let week = *weeks.last()?;

    let mut losers = [Entrant::default(); 2];
    for (index, game) in semis.games[..2].iter().enumerate() {
        let loser = loser_of(game)?;
        losers[index] = Entrant {
            team: loser,
            seed: if loser == game.home {
                game.home_seed
            } else {
                game.away_seed
            },
        };
    }
    sort_by_seed(&mut losers);

    let (home, away) = (losers[0], losers[1]);
    let result = find_result(results, week, home.team, away.team);
    let (winner, decided_by_seed) = match result {
        Some(played) => {
            let home_points = points_for(&played, home.team);
            let away_points = points_for(&played, away.team);
            (
                Some(advance(home, away, home_points, away_points)),
                home_points == away_points,
            )
        }
        None => (None, false),
    };

    Some(Game {
        week,
        round: semis.round + 1,
        home: home.team,
        away: away.team,
        home_seed: home.seed,
        away_seed: away.seed,
        winner,
        decided_by_seed,
    })
}

/// A result for this pair in this week, **in either orientation**.
///
/// Which team a stored row calls home is the database's business; a bracket game
/// is looked up by its pair. Note that [`points_for`] then reads the points by
/// the *result's* own orientation rather than positionally — taking them
/// positionally would hand every reversed row's score to the wrong team, which
/// is a silent way to invert a playoff game.
fn find_result(results: &[PlayoffResult], week: u8, home: u8, away: u8) -> Option<PlayoffResult> {
    results
        .iter()
        .find(|r| {
            r.week == week
                && ((r.home == home && r.away == away) || (r.home == away && r.away == home))
        })
        .copied()
}

fn points_for(result: &PlayoffResult, team: u8) -> u32 {
    if result.home == team {
        result.home_milli_points
    } else {
        result.away_milli_points
    }
}

/// Who goes through.
///
/// Points decide it; equal points go to the higher seed. **This is the one place
/// bracket scoring differs from the regular season**, where a tie is a real
/// result and both teams keep it — see `docs/RULES.md` §5. A bracket cannot have
/// one, because somebody has to play next week.
fn advance(home: Entrant, away: Entrant, home_points: u32, away_points: u32) -> u8 {
    if home_points > away_points {
        return home.team;
    }
    if away_points > home_points {
        return away.team;
    }
    if home.seed < away.seed {
        home.team
    } else {
        away.team
    }
}

fn loser_of(game: &Game) -> Option<u8> {
    let winner = game.winner?;
    Some(if winner == game.home {
        game.away
    } else {
        game.home
    })
}

/// Insertion sort — at most sixteen entries, and no allocator.
fn sort_by_seed(entrants: &mut [Entrant]) {
    for i in 1..entrants.len() {
        let mut j = i;
        while j > 0 && entrants[j - 1].seed > entrants[j].seed {
            entrants.swap(j - 1, j);
            j -= 1;
        }
    }
}

/// Byes needed to bring a round down to a power of two.
fn byes_needed(alive: usize) -> usize {
    if alive <= 1 {
        return 0;
    }
    next_power_of_two(alive) - alive
}

fn next_power_of_two(n: usize) -> usize {
    let mut power = 1usize;
    while power < n {
        power *= 2;
    }
    power
}

/// How many rounds a field of this size takes to resolve to one team.
///
/// ## Why this counts in halves
///
/// The TypeScript computes `alive = (field - byes) / 2 + byes` in floating
/// point, so an odd `field - byes` leaves it holding **half a team** — five
/// teams with no byes gives 2.5 — and the loop then rounds that up through
/// `nextPowerOfTwo`. Integer division would quietly disagree, and only on inputs
/// that are about to be refused, which is the worst place for a divergence: for
/// five teams in a two-week window the TypeScript answers `NOT_ENOUGH_WEEKS` and
/// a truncating kernel would proceed and answer `BracketInvariant` instead.
///
/// So `a2` is twice `alive`, which makes the fraction exact. After the first
/// iteration `alive` is always whole again — the next value is `nextPow2(alive)
/// / 2`, and that power is at least two whenever the loop runs.
fn rounds_needed(field: usize, first_round_byes: usize) -> usize {
    // (field - byes) + 2 * byes, doubled through, is field + byes.
    let mut a2 = field + first_round_byes;
    let mut rounds = 1usize;

    // `alive > 1` is `a2 > 2`.
    while a2 > 2 {
        // The smallest power of two at or above `alive`, i.e. above `a2 / 2`.
        let mut power = 1usize;
        while 2 * power < a2 {
            power *= 2;
        }
        a2 = power;
        rounds += 1;
    }

    rounds
}

#[cfg(test)]
mod conformance {
    //! The bracket corpus, run against this implementation.
    //!
    //! Every expectation is **generated** by running `buildBracket` — see
    //! `packages/core/src/season/conformance`. A failure here means this file
    //! disagrees with the TypeScript that decides what members are shown, and
    //! the TypeScript is the spec.

    use super::*;
    use serde::Deserialize;

    const CORPUS: &str =
        include_str!("../../../packages/core/src/season/conformance/bracket-corpus.json");

    #[derive(Deserialize)]
    struct Corpus {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        #[allow(dead_code)]
        why: String,
        field: Vec<String>,
        weeks: Vec<u8>,
        first_round_byes: usize,
        results: Vec<RawResult>,
        third_place: bool,
        #[serde(default)]
        rounds: Option<Vec<RawRound>>,
        #[serde(default)]
        champion: Option<String>,
        #[serde(default)]
        runner_up: Option<String>,
        #[serde(default)]
        third_place_game: Option<RawGame>,
        #[serde(default)]
        third_place_holder: Option<String>,
        #[serde(default)]
        refusal: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawResult {
        week: u8,
        home_team_id: String,
        away_team_id: Option<String>,
        home_milli_points: u32,
        away_milli_points: u32,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawRound {
        week: u8,
        round: u8,
        games: Vec<RawGame>,
        byes: Vec<String>,
        survivors: Option<Vec<String>>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawGame {
        home_team_id: String,
        away_team_id: String,
        winner_team_id: Option<String>,
        decided_by_seed: bool,
    }

    /// The corpus records a refusal *code*; the kernel returns an Anchor error.
    /// Mapping them here rather than comparing messages is deliberate — a
    /// message is prose and drifts, a code is the contract.
    fn refusal_matches(code: &str, error: &anchor_lang::error::Error) -> bool {
        let expected: u32 = match code {
            "FIELD_TOO_SMALL" => DeriveError::FieldTooSmall.into(),
            "NOT_ENOUGH_WEEKS" => DeriveError::NotEnoughWeeks.into(),
            "INVARIANT" => DeriveError::BracketInvariant.into(),
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
            // The whole league, in seed order, is the field itself here — the
            // corpus talks about a bracket, not a season, so a team index is a
            // position in `field`.
            let index_of = |wanted: &str| -> u8 {
                case.field
                    .iter()
                    .position(|id| id == wanted)
                    .map(|position| position as u8)
                    .unwrap_or_else(|| panic!("{}: {wanted} is not in the field", case.name))
            };

            let field: Vec<u8> = (0..case.field.len() as u8).collect();
            let results: Vec<PlayoffResult> = case
                .results
                .iter()
                // A bye has no away team and can never be a bracket game. The
                // TypeScript skips these when indexing; dropping them here is
                // the same rule, one layer earlier.
                .filter_map(|raw| {
                    raw.away_team_id.as_ref().map(|away| PlayoffResult {
                        week: raw.week,
                        home: index_of(&raw.home_team_id),
                        away: index_of(away),
                        home_milli_points: raw.home_milli_points,
                        away_milli_points: raw.away_milli_points,
                    })
                })
                .collect();

            let built = build_bracket(
                &field,
                &case.weeks,
                case.first_round_byes,
                &results,
                case.third_place,
            );

            match (&case.rounds, &case.refusal) {
                (Some(expected_rounds), None) => {
                    let bracket = built.unwrap_or_else(|error| {
                        panic!("{}: expected a bracket, got {error:?}", case.name)
                    });

                    assert_eq!(
                        bracket.round_count,
                        expected_rounds.len(),
                        "{}: round count",
                        case.name
                    );

                    for (index, expected) in expected_rounds.iter().enumerate() {
                        let actual = &bracket.rounds[index];
                        assert_eq!(
                            actual.week, expected.week,
                            "{}: round {index} week",
                            case.name
                        );
                        assert_eq!(
                            actual.round, expected.round,
                            "{}: round {index} number",
                            case.name
                        );
                        assert_eq!(
                            actual.game_count,
                            expected.games.len(),
                            "{}: round {index} game count",
                            case.name
                        );

                        for (slot, want) in expected.games.iter().enumerate() {
                            let got = &actual.games[slot];
                            assert_eq!(
                                got.home,
                                index_of(&want.home_team_id),
                                "{}: round {index} game {slot} home",
                                case.name
                            );
                            assert_eq!(
                                got.away,
                                index_of(&want.away_team_id),
                                "{}: round {index} game {slot} away",
                                case.name
                            );
                            assert_eq!(
                                got.winner,
                                want.winner_team_id.as_deref().map(&index_of),
                                "{}: round {index} game {slot} winner",
                                case.name
                            );
                            assert_eq!(
                                got.decided_by_seed, want.decided_by_seed,
                                "{}: round {index} game {slot} decidedBySeed",
                                case.name
                            );
                        }

                        let byes: Vec<u8> = actual.byes[..actual.bye_count]
                            .iter()
                            .map(|e| e.team)
                            .collect();
                        let expected_byes: Vec<u8> =
                            expected.byes.iter().map(|id| index_of(id)).collect();
                        assert_eq!(byes, expected_byes, "{}: round {index} byes", case.name);

                        match &expected.survivors {
                            Some(want) => {
                                assert!(
                                    actual.resolved,
                                    "{}: round {index} should have resolved",
                                    case.name
                                );
                                let got: Vec<u8> = actual.survivors[..actual.survivor_count]
                                    .iter()
                                    .map(|e| e.team)
                                    .collect();
                                let want: Vec<u8> = want.iter().map(|id| index_of(id)).collect();
                                assert_eq!(got, want, "{}: round {index} survivors", case.name);
                            }
                            None => assert!(
                                !actual.resolved,
                                "{}: round {index} should not have resolved",
                                case.name
                            ),
                        }
                    }

                    assert_eq!(
                        bracket.champion,
                        case.champion.as_deref().map(&index_of),
                        "{}: champion",
                        case.name
                    );
                    assert_eq!(
                        bracket.runner_up,
                        case.runner_up.as_deref().map(&index_of),
                        "{}: runner-up",
                        case.name
                    );

                    match &case.third_place_game {
                        Some(want) => {
                            let got = bracket.third_place_game.unwrap_or_else(|| {
                                panic!("{}: expected a third-place game", case.name)
                            });
                            assert_eq!(
                                got.home,
                                index_of(&want.home_team_id),
                                "{}: third place home",
                                case.name
                            );
                            assert_eq!(
                                got.away,
                                index_of(&want.away_team_id),
                                "{}: third place away",
                                case.name
                            );
                            assert_eq!(
                                got.winner,
                                want.winner_team_id.as_deref().map(&index_of),
                                "{}: third place winner",
                                case.name
                            );
                            assert_eq!(
                                got.decided_by_seed, want.decided_by_seed,
                                "{}: third place decidedBySeed",
                                case.name
                            );
                        }
                        None => assert!(
                            bracket.third_place_game.is_none(),
                            "{}: expected no third-place game",
                            case.name
                        ),
                    }

                    assert_eq!(
                        third_place_winner(&bracket),
                        case.third_place_holder.as_deref().map(&index_of),
                        "{}: third-place holder",
                        case.name
                    );
                }
                (None, Some(code)) => {
                    let error = built
                        .expect_err(&format!("{}: expected a refusal, got a bracket", case.name));
                    assert!(
                        refusal_matches(code, &error),
                        "{}: expected {code}, got {error:?}",
                        case.name
                    );
                }
                _ => panic!(
                    "{}: corpus records neither one outcome nor the other",
                    case.name
                ),
            }
        }
    }

    /// The fractional-round-count divergence, pinned directly.
    ///
    /// Five teams with no byes leaves `(5 - 0) / 2 = 2.5` alive in the
    /// TypeScript, which rounds up through `nextPowerOfTwo` to three rounds.
    /// A kernel using integer division computes two, and in a two-week window
    /// that is the difference between `NOT_ENOUGH_WEEKS` and reaching the odd
    /// pairing and answering `BracketInvariant`. Both are refusals, which is
    /// exactly why the corpus alone would not have caught it — the case that
    /// exposes it has to name the *code*.
    #[test]
    fn counts_rounds_the_way_the_typescript_does() {
        assert_eq!(rounds_needed(5, 0), 3);
        assert_eq!(rounds_needed(4, 0), 2);
        assert_eq!(rounds_needed(6, 2), 3);
        assert_eq!(rounds_needed(8, 0), 3);
        assert_eq!(rounds_needed(2, 0), 1);
        assert_eq!(rounds_needed(5, 3), 3);
        // The widest legal input, and the reason MAX_BRACKET_ROUNDS is five.
        assert_eq!(rounds_needed(MAX_TEAMS, MAX_TEAMS - 1), MAX_BRACKET_ROUNDS);

        let field: Vec<u8> = (0..5).collect();
        let error = build_bracket(&field, &[16, 17], 0, &[], false)
            .expect_err("five teams cannot resolve in two weeks");
        let expected: u32 = DeriveError::NotEnoughWeeks.into();
        assert!(
            matches!(
                error,
                anchor_lang::error::Error::AnchorError(ref inner)
                    if inner.error_code_number == expected
            ),
            "expected NOT_ENOUGH_WEEKS, got {error:?}"
        );
    }
}
