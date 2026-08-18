/**
 * The scoring conformance corpus.
 *
 * ## What this is for
 *
 * A sweep of all 544 games of 2025 and 2024 found every scoring defect this repo
 * knows about — `BP`, the returner nobody paid, the two-point receiver, the
 * blocked kicks that never scored, the D/ST touchdown counted twice. **That
 * sweep was a throwaway script.** It cost hundreds of metered calls, it ran
 * once, and nothing was left behind that would notice the same class of defect
 * arriving again.
 *
 * The cost of noticing late is not "a bug for a while". Points are recomputed on
 * every run until the correction window closes, and then `finalized_at` is set
 * and **a finalised week is never rescored**. A translator regression that lands
 * on a Thursday has decided real matchups, real playoff seeds and — in weeks 14
 * and 17 — real money by the following Wednesday, permanently.
 *
 * So thirteen of those games are checked in, and this runs on every `pnpm test`.
 *
 * ## Four independent checks, and none of them is "the numbers still match"
 *
 * 1. **Coverage.** Every game claims what it is FOR, and the claim is re-derived
 *    from the Tank01 fixture. A corpus that reconciles perfectly and contains no
 *    scoring D/ST, no 60-yard field goal and no `BP` play is worthless and looks
 *    green; {@link ./classes.ts} is what stops it becoming that quietly.
 *
 * 2. **The ledger.** What our translator and our scoring table pay every player
 *    and every unit in every game, generated and diffable. This is the
 *    regression guard proper.
 *
 * 3. **Sleeper.** The only genuine second source. Their raw stats, run through
 *    **our** scoring table — never their points — so a disagreement is about
 *    what happened on the field rather than about whose table pays 4 for a
 *    passing touchdown.
 *
 * 4. **ESPN as a republication.** Tank01 *is* ESPN reserialised, so an ESPN
 *    column would be a second reading of one source dressed as corroboration.
 *    Instead the republication itself is asserted. See {@link ./espn.ts}.
 *
 * ## Offline, always
 *
 * No network, no credentials, no metered calls — `CLAUDE.md`'s rule that the
 * core stays testable without a single credential, and the plain fact that CI
 * has no Tank01 key. Capturing is a separate command (`pnpm stats:corpus-sync`)
 * and regenerating the ledgers is another (`pnpm corpus:stats`). **CI runs
 * neither.** A generated golden invites regenerate-to-green; the defence is that
 * regenerating is a deliberate act with a diff attached.
 */

import { describe, expect, it } from "vitest";
import { indexScoringRules, NFL_PPR_SCORING, scorePlayer } from "@rostr/core";
import { classesIn, COVERAGE_CLASSES } from "./classes.js";
import { buildLedger, serialiseLedger } from "./ledger.js";
import { manifestProblems } from "./manifest.js";
import { sleeperPlayerStats, sleeperTeamDefenseStats } from "./sleeper.js";
import { checkRepublication, normalisePlayText } from "./espn.js";
import { sleeperTeam } from "./capture.js";
import {
  boxScoreFileNames,
  corpusFileNames,
  readBoxScore,
  readEspn,
  readIdMap,
  readLedger,
  readManifest,
  readSleeper,
} from "./fixtures.js";

const RULES = indexScoringRules(NFL_PPR_SCORING);
const manifest = readManifest();
const idMap = readIdMap();

/** Everything read off disk once, so a failure names the game rather than a path. */
const corpus = manifest.games.map((game) => ({
  game,
  box: readBoxScore(game.boxScore) as Record<string, unknown>,
  ledger: readLedger(game.gameRef),
  sleeper: readSleeper(game.gameRef),
  espn: readEspn(game.gameRef),
}));

const cases = corpus.map((entry) => [entry.game.gameRef, entry] as const);

describe("the manifest", () => {
  it("is internally consistent, and every registered class is claimed", () => {
    // Both directions. A game claiming a class that does not exist is a typo; a
    // class no game claims is a check with no data behind it, which is the more
    // expensive of the two because it reads as coverage.
    expect(manifestProblems(manifest, Object.keys(COVERAGE_CLASSES))).toEqual([]);
  });

  it("claims every captured box score", () => {
    // A raw response sitting in the tree that no manifest entry names is a game
    // nothing is checked against — which is how a fixture captured for an
    // afternoon's investigation comes to look like permanent coverage.
    const claimed = new Set(manifest.games.map((game) => game.boxScore));
    expect(boxScoreFileNames().filter((name) => !claimed.has(name))).toEqual([]);
  });

  it("names the week the fixture is actually from", () => {
    // The Sleeper fixture is a whole week of the league cut down to this game,
    // and it is fetched by season and week from *here*. A manifest off by one
    // would compare a real game against a real week that is not its own, and
    // every player would disagree for a reason no message would explain.
    for (const { game, box } of corpus) {
      expect(`${game.gameRef} ${String(box["gameWeek"])}`).toBe(
        `${game.gameRef} Week ${game.week}`,
      );
      expect(`${game.gameRef} ${String(box["seasonType"])}`).toBe(
        `${game.gameRef} Regular Season`,
      );
    }
  });
});

describe("coverage", () => {
  it.each(cases)("%s still contains what it was chosen for", (_gameRef, { game, box }) => {
    // Derived from the **Tank01** fixture, never from the ESPN column. ESPN's
    // labels are richer and easier to search — `"Blocked Punt Touchdown"` is
    // right there — but the translator reads Tank01, and `SCORE_TYPE_BP` names
    // a value ESPN does not publish at all.
    const present = new Set(classesIn(box));
    const lost = game.classes.filter((name) => !present.has(name));

    expect({ game: game.gameRef, lost }).toEqual({ game: game.gameRef, lost: [] });
  });
});

describe("the ledger", () => {
  it.each(cases)(
    "%s scores exactly as the checked-in ledger says",
    (_gameRef, { game, box }) => {
      const rebuilt = serialiseLedger(buildLedger(box, RULES));
      const stored = serialiseLedger(readLedger(game.gameRef));

      // Compared as objects rather than as strings so the failure output is a
      // structural diff of the game rather than a wall of JSON. The serialised
      // form is what `pnpm corpus:stats` writes, and it is deterministic — sorted
      // keys, sorted rows — so the two cannot differ for a reason nobody moved.
      expect(JSON.parse(rebuilt)).toEqual(JSON.parse(stored));
    },
  );

  it.each(cases)("%s reads cleanly, or says why not", (_gameRef, { game, ledger }) => {
    expect({ game: game.gameRef, fatal: ledger.fatal }).toEqual({
      game: game.gameRef,
      fatal: [],
    });
  });

  it("is checked in for every game and nothing else", () => {
    // Both directions, and the second is the one that needed a real check. A
    // *missing* ledger already fails, loudly, in the eager read above. An
    // **orphan** did not: a ledger, Sleeper week or ESPN page left behind by a
    // game somebody removed from the manifest is compared against nothing and
    // reads as coverage — the same failure the unclaimed-box-score test catches
    // one directory up.
    //
    // This assertion used to be `expect(ledgerPath(ref)).toContain(ref)`, which
    // cannot fail: the path is built from the ref.
    const claimed = manifest.games.map((game) => game.gameRef).sort();

    for (const directory of ["ledgers", "sleeper", "espn"] as const) {
      expect({ directory, files: corpusFileNames(directory) }).toEqual({
        directory,
        files: claimed,
      });
    }
  });
});

describe("ESPN, as a republication rather than a second opinion", () => {
  it.each(cases)(
    "%s republishes every Tank01 scoring play",
    (_gameRef, { game, box, espn }) => {
      const tankPlays = (box["scoringPlays"] ?? []) as { score?: string; scoreType?: string }[];
      const { mismatches, unmatchedEspn } = checkRepublication(tankPlays, espn.scoringPlays);

      const declared = new Set(
        (game.espnTypeDisagreements ?? []).map((entry) => normalisePlayText(entry.text)),
      );

      // A text Tank01 serves and ESPN does not is always a failure: it would mean
      // Tank01 had started writing its own prose, which is the assumption every
      // other comparison in this repo rests on.
      const undeclared = mismatches.filter(
        (mismatch) => mismatch.kind !== "TYPE_DISAGREES" || !declared.has(mismatch.tankText),
      );

      expect({ game: game.gameRef, undeclared }).toEqual({
        game: game.gameRef,
        undeclared: [],
      });
      expect({ game: game.gameRef, unmatchedEspn }).toEqual({
        game: game.gameRef,
        unmatchedEspn: [...(game.espnExtraPlays ?? [])],
      });
    },
  );

  it.each(cases)(
    "%s declares no exception it no longer needs",
    (_gameRef, { game, box, espn }) => {
      const tankPlays = (box["scoringPlays"] ?? []) as { score?: string; scoreType?: string }[];
      const { mismatches } = checkRepublication(tankPlays, espn.scoringPlays);
      const actual = new Set(
        mismatches
          .filter((mismatch) => mismatch.kind === "TYPE_DISAGREES")
          .map((mismatch) => mismatch.tankText),
      );

      // The same rule the Sleeper exceptions follow, and for the same reason: an
      // exception that outlives the thing it described goes on suppressing a
      // comparison nobody is watching any more.
      const stale = (game.espnTypeDisagreements ?? [])
        .map((entry) => normalisePlayText(entry.text))
        .filter((text) => !actual.has(text));

      expect({ game: game.gameRef, stale }).toEqual({ game: game.gameRef, stale: [] });
    },
  );
});

// ---------------------------------------------------------------------------
// Sleeper
// ---------------------------------------------------------------------------

interface Comparison {
  readonly gameRef: string;
  readonly subject: string;
  readonly name: string;
  readonly ourMilliPoints: number;
  readonly sleeperMilliPoints: number;
  readonly differingKeys: readonly string[];
}

/**
 * Every subject in one game where our reading and Sleeper's disagree.
 *
 * The subject set is the **ledger**, which is to say every player and unit our
 * translator produced a stat for. A Sleeper player we never joined to is not
 * silently skipped — {@link joinFailures} counts those separately, because "we
 * could not find him" and "we agree with him" must not look the same.
 */
function disagreementsIn(entry: (typeof corpus)[number]): Comparison[] {
  const out: Comparison[] = [];

  for (const row of entry.ledger.players) {
    const mapped = idMap[row.ref];
    const raw = mapped ? entry.sleeper.stats[mapped.id] : undefined;
    if (!raw) continue;

    const theirs = sleeperPlayerStats(raw);
    push(out, entry, `player:${row.ref}`, row, theirs);
  }

  for (const row of entry.ledger.teamDefense) {
    const raw = entry.sleeper.stats[sleeperTeam(row.ref)];
    if (!raw) continue;

    const theirs = sleeperTeamDefenseStats(raw);
    push(out, entry, `dst:${row.ref}`, row, theirs);
  }

  return out;
}

function push(
  out: Comparison[],
  entry: (typeof corpus)[number],
  subject: string,
  row: {
    ref: string;
    name: string;
    stats: Readonly<Record<string, number>>;
    milliPoints: number;
  },
  theirs: readonly { statKey: string; value: number }[],
): void {
  const sleeperMilliPoints = scorePlayer(theirs, RULES);

  const theirStats = new Map(theirs.map((line) => [line.statKey, line.value]));
  const keys = new Set([...Object.keys(row.stats), ...theirStats.keys()]);
  const differingKeys = [...keys]
    .filter((key) => (row.stats[key] ?? 0) !== (theirStats.get(key) ?? 0))
    .sort()
    .map((key) => `${key}: ours ${row.stats[key] ?? 0}, theirs ${theirStats.get(key) ?? 0}`);

  // **The gate is the stats, not the totals**, and it used to be the totals.
  // `sleeper.ts` says in as many words that the comparison is of stats and never
  // of points; returning early on equal totals made that false, and two of the
  // tiered ladders hid a real divergence behind it — `def_pts_allowed` can move
  // by six and pay the same, because the tier is a range. A stat gap that is
  // worth nothing today is worth six the week the number lands one either side
  // of a boundary, which is exactly when nobody is looking.
  if (differingKeys.length === 0) return;

  out.push({
    gameRef: entry.game.gameRef,
    subject,
    name: row.name,
    ourMilliPoints: row.milliPoints,
    sleeperMilliPoints,
    differingKeys,
  });
}

/**
 * Ledger rows carrying stats that no Sleeper row could be found for.
 *
 * **Units are included, unconditionally.** `disagreementsIn` skips a unit whose
 * Sleeper row is missing, and for a while nothing counted that — so a team
 * abbreviation the two providers spell differently would drop the comparison for
 * both D/ST rows in the game and look exactly like agreement. There are only 32
 * of them and every one plays every week, so unlike a player there is no
 * legitimate reason for a unit to be absent; `SLEEPER_TEAM_ALIASES` exists
 * precisely because at least one is spelled differently.
 *
 * Players are still filtered on `milliPoints !== 0`: a real box score carries
 * sixty of them who did nothing, and requiring a Sleeper row for every long
 * snapper would be noise rather than a check.
 */
function joinFailures(
  entry: (typeof corpus)[number],
): readonly { ref: string; name: string; milliPoints: number }[] {
  const players = entry.ledger.players
    .filter((row) => {
      const mapped = idMap[row.ref];
      return row.milliPoints !== 0 && (!mapped || !entry.sleeper.stats[mapped.id]);
    })
    .map((row) => ({ ref: row.ref, name: row.name, milliPoints: row.milliPoints }));

  const units = entry.ledger.teamDefense
    .filter((row) => !entry.sleeper.stats[sleeperTeam(row.ref)])
    .map((row) => ({ ref: `dst:${row.ref}`, name: row.name, milliPoints: row.milliPoints }));

  return [...players, ...units];
}

const key = (gameRef: string, subject: string): string => `${gameRef} ${subject}`;

describe("Sleeper, the only genuine second source", () => {
  it.each(cases)("%s joins every scoring player to a Sleeper row", (_gameRef, entry) => {
    // A join that quietly fails looks exactly like agreement: no comparison
    // runs, nothing is reported, and the game passes. Every player our side
    // pays anything has to be reachable, or the check below is measuring less
    // than it appears to.
    const declared = new Set(manifest.unjoinable.map((row) => row.ref));

    expect({
      game: entry.game.gameRef,
      unjoined: joinFailures(entry).filter((row) => !declared.has(row.ref)),
    }).toEqual({ game: entry.game.gameRef, unjoined: [] });
  });

  it("declares nobody as unjoinable who can now be joined", () => {
    // Same expiry rule as the disagreements. A player who becomes reachable —
    // because the provider fixed his id, or because he was recaptured — has to
    // come off the list, or he is silently excluded from every comparison for
    // as long as the entry survives.
    const stillFailing = new Set(
      corpus.flatMap((entry) => joinFailures(entry)).map((row) => row.ref),
    );

    const resolved = manifest.unjoinable
      .filter((row) => !stillFailing.has(row.ref))
      .map((row) => `${row.ref} ${row.name} — issue #${row.issue} — ${row.reason}`);

    expect(resolved).toEqual([]);
  });

  it.each(cases)("%s agrees with Sleeper except where declared", (_gameRef, entry) => {
    const declared = new Set(
      manifest.knownDisagreements.map((row) => key(row.gameRef, row.subject)),
    );

    const undeclared = disagreementsIn(entry).filter(
      (row) => !declared.has(key(row.gameRef, row.subject)),
    );

    expect({ game: entry.game.gameRef, undeclared }).toEqual({
      game: entry.game.gameRef,
      undeclared: [],
    });
  });

  it("declares no disagreement that has been resolved", () => {
    // **The regenerate-to-green guard.** A stale exception is how a fixed bug
    // silently un-fixes: the entry goes on suppressing its comparison long after
    // the thing it described was repaired, and the next regression in the same
    // player lands inside its shadow. So an exception that no longer describes
    // anything is a failure, and the fix is to delete it — which is a diff, in
    // review, next to the change that closed it.
    const live = new Map(
      corpus.flatMap((entry) =>
        disagreementsIn(entry).map((row) => [key(row.gameRef, row.subject), row]),
      ),
    );

    const stale = manifest.knownDisagreements
      .filter((row) => !live.has(key(row.gameRef, row.subject)))
      .map((row) => `${key(row.gameRef, row.subject)} — issue #${row.issue} — ${row.reason}`);

    expect(stale).toEqual([]);
  });

  it("pins the size of every disagreement it tolerates", () => {
    // An exception written for a 2-point gap must not go on covering a 20-point
    // one. Recording both totals is what makes the entry expire when the gap
    // *moves* as well as when it closes.
    const live = new Map(
      corpus.flatMap((entry) =>
        disagreementsIn(entry).map((row) => [key(row.gameRef, row.subject), row]),
      ),
    );

    const moved = manifest.knownDisagreements
      .map((row) => ({ row, actual: live.get(key(row.gameRef, row.subject)) }))
      .filter(
        ({ row, actual }) =>
          actual &&
          (actual.ourMilliPoints !== row.ourMilliPoints ||
            actual.sleeperMilliPoints !== row.sleeperMilliPoints),
      )
      .map(({ row, actual }) => ({
        subject: key(row.gameRef, row.subject),
        declared: [row.ourMilliPoints, row.sleeperMilliPoints],
        actual: [actual?.ourMilliPoints, actual?.sleeperMilliPoints],
      }));

    expect(moved).toEqual([]);
  });
});
