/**
 * The manifest: the only hand-written file in the corpus.
 *
 * Everything else under `__fixtures__/corpus/` is either a captured provider
 * response or a generated ledger. This is where a human says **why** a game is
 * in the corpus, what it is expected to prove, and which disagreements with
 * Sleeper are known and accepted.
 *
 * ## The two guards that make a generated corpus worth having
 *
 * **A game must still contain what it was chosen for.** `classes` is re-derived
 * from the Tank01 fixture on every run. A corpus of thirteen real games that all
 * reconcile perfectly and contain no `BP` play, no shutout and no 60-yard field
 * goal is worthless and looks green; this is what stops it becoming that
 * quietly.
 *
 * **A known disagreement must expire.** Every entry in `knownDisagreements`
 * carries a reason and an issue number, and the test fails when a declared
 * disagreement **stops happening**. A stale exception is how a fixed bug
 * silently un-fixes itself: the entry goes on suppressing the comparison long
 * after the thing it described was repaired, and the next regression lands
 * inside its shadow.
 */

/** A game in the corpus. */
export interface ManifestGame {
  /** Tank01 `gameID`. Also the name of the ledger, Sleeper and ESPN fixtures. */
  readonly gameRef: string;
  readonly season: number;
  readonly week: number;
  /** File name of the raw Tank01 response, relative to `__fixtures__/`. */
  readonly boxScore: string;
  /** One sentence: what this game is in the corpus for. */
  readonly why: string;
  /** Coverage classes this game claims. Re-derived from the fixture on every run. */
  readonly classes: readonly string[];
  /**
   * Scoring plays ESPN serves that Tank01 does not, verbatim and
   * whitespace-normalised.
   *
   * Not an error in principle, but declared rather than tolerated, so a play
   * Tank01 *stopped* serving cannot pass itself off as an ESPN artifact.
   *
   * **No captured game needs this**: Tank01 and ESPN serve the same number of
   * scoring plays in all thirteen. The field is kept because the check is
   * deliberately asymmetric — a Tank01 play ESPN lacks is always a failure, an
   * ESPN play Tank01 lacks is explainable — and an explanation has to go
   * somewhere a reviewer will see it.
   */
  readonly espnExtraPlays?: readonly string[];
  /**
   * Plays where ESPN's `scoringType` and Tank01's `scoreType` differ.
   *
   * Rare and each one interesting: the known case is a kickoff recovered in the
   * end zone, which ESPN leaves untyped and Tank01 files as `TD`. Declared for
   * the same reason as everything else here — an undeclared type disagreement is
   * evidence the two feeds have started to diverge, which is the one thing
   * {@link ./espn.ts} exists to detect, and it must not be lost in a list of
   * known ones.
   */
  readonly espnTypeDisagreements?: readonly {
    readonly text: string;
    readonly reason: string;
  }[];
}

/**
 * A subject where our reading and Sleeper's disagree, on purpose.
 *
 * `subject` is `player:<tank01 playerID>` or `dst:<team abbreviation>`.
 *
 * `ourMilliPoints` and `sleeperMilliPoints` are pinned rather than merely
 * described, so an exception written for a 2-point gap cannot go on covering a
 * 20-point one.
 */
export interface KnownDisagreement {
  readonly gameRef: string;
  readonly subject: string;
  /**
   * Whether this is something to fix or something decided.
   *
   * The distinction is not decoration. A `DEFECT` is a live bug the corpus is
   * holding open — it should get smaller and then vanish, and the day it does
   * the entry has to come out. A `DELIBERATE` divergence is a decision recorded
   * against an issue, and it is expected to sit there indefinitely. Collapsing
   * the two would make an entry that is never going to expire look identical to
   * one that has been neglected for months.
   */
  readonly kind: "DEFECT" | "DELIBERATE";
  /** Why the two differ, in enough detail that a reader can judge it. */
  readonly reason: string;
  /** The open issue tracking it. Required — an exception with no ticket is a decision nobody made. */
  readonly issue: number;
  readonly ourMilliPoints: number;
  readonly sleeperMilliPoints: number;
}

/**
 * A player the corpus cannot compare, because the join to Sleeper fails.
 *
 * Declared, never skipped. **An unjoined player is indistinguishable from an
 * agreeing one** unless somebody writes it down: no comparison runs, nothing is
 * reported, and the game passes — which is the failure mode this whole file is
 * built against. Naming him costs one line and turns silence into a fact.
 */
export interface Unjoinable {
  /** Tank01 `playerID`. */
  readonly ref: string;
  readonly name: string;
  readonly reason: string;
  readonly issue: number;
}

export interface Manifest {
  readonly games: readonly ManifestGame[];
  readonly knownDisagreements: readonly KnownDisagreement[];
  readonly unjoinable: readonly Unjoinable[];
}

/**
 * Problems with the manifest itself, as messages.
 *
 * Returned rather than thrown, in the house style: a corpus with three bad
 * entries should report three, not the first.
 */
export function manifestProblems(
  manifest: Manifest,
  registeredClasses: readonly string[],
): string[] {
  const problems: string[] = [];
  const known = new Set(registeredClasses);
  const seen = new Set<string>();

  for (const game of manifest.games) {
    if (seen.has(game.gameRef)) problems.push(`${game.gameRef} appears twice`);
    seen.add(game.gameRef);

    if (!game.why.trim()) problems.push(`${game.gameRef} has no "why"`);
    if (game.classes.length === 0) {
      problems.push(
        `${game.gameRef} claims no coverage class — a game that proves nothing ` +
          `is a fixture, not a corpus entry`,
      );
    }
    for (const name of game.classes) {
      if (!known.has(name)) problems.push(`${game.gameRef} claims unknown class ${name}`);
    }
  }

  const claimed = new Set(manifest.games.flatMap((game) => game.classes));
  for (const name of registeredClasses) {
    if (!claimed.has(name)) {
      problems.push(
        `class ${name} is registered in classes.ts and no game claims it — ` +
          `capture a game for it or delete the class`,
      );
    }
  }

  for (const entry of manifest.knownDisagreements) {
    const where = `${entry.gameRef} ${entry.subject}`;
    if (!seen.has(entry.gameRef)) problems.push(`disagreement ${where} names no corpus game`);
    if (!entry.reason.trim()) problems.push(`disagreement ${where} has no reason`);
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
      problems.push(`disagreement ${where} has no issue number`);
    }
    if (entry.kind !== "DEFECT" && entry.kind !== "DELIBERATE") {
      problems.push(`disagreement ${where} does not say whether it is a defect or a decision`);
    }
  }

  for (const entry of manifest.unjoinable) {
    if (!entry.reason.trim()) problems.push(`unjoinable ${entry.ref} has no reason`);
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
      problems.push(`unjoinable ${entry.ref} has no issue number`);
    }
  }

  return problems;
}
