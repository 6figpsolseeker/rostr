/**
 * The ledger: what this repo says a real game is worth.
 *
 * One generated file per corpus game, holding every stat line the translator
 * produced and the milli-points our own scoring table pays for it.
 * `corpus.test.ts` regenerates it from the checked-in Tank01 response on every
 * run and fails when the two **differ in structure** — both sides are parsed
 * before comparing, so the failure output is a diff of the game rather than a
 * wall of JSON. Key order and indentation are therefore not what fails here;
 * `format:check` covers those, which is why {@link serialiseLedger} emits exactly
 * what prettier would.
 *
 * ## Generated, never hand-edited
 *
 * A hand-written expectation is a third implementation of the scoring table with
 * no tests of its own, and it drifts. The standings corpus in
 * `packages/core/src/season/conformance/` is the same shape for the same reason.
 * The file exists so a **diff** is the signal: a translator change that moves one
 * player's points shows up as one line, in review, before it reaches a Sunday.
 *
 * ## Which is why regeneration is a separate command
 *
 * `pnpm corpus:stats` writes these; `pnpm test` only compares. Nothing in CI runs
 * the writer. A generated golden invites regenerate-to-green — the reflex of
 * running the writer to make a red suite go quiet — and the only defence is that
 * regenerating is a deliberate act with a diff attached to it. Read the diff. A
 * changed number here means somebody's score moved.
 *
 * ## What is in the file, and what is deliberately not
 *
 * Entries with no stats at all are omitted, and `playersTranslated` carries the
 * count instead. A box score has around ninety players in it and most of them
 * are long snappers; writing ninety empty rows per game would bury the twenty
 * that matter and make every diff unreadable. The count is what catches a player
 * silently disappearing from the translation, and a player who *gains* a stat
 * appears as a new row.
 *
 * `warnings` are recorded in full and in order. They are the translator's own
 * account of what did not reconcile, and a change in them is exactly as
 * interesting as a change in a score — a warning that stops firing usually means
 * a cross-check stopped being able to see the thing it checks.
 */

import type { ScoringRule, StatLine } from "@rostr/core";
import { scorePlayer } from "@rostr/core";
import { translateBoxScore } from "../tank01/box-score.js";

export interface LedgerEntry {
  /** Tank01 `playerID` for a player, team abbreviation for a unit. */
  readonly ref: string;
  readonly name: string;
  readonly stats: Readonly<Record<string, number>>;
  readonly milliPoints: number;
}

export interface Ledger {
  readonly gameRef: string;
  /**
   * How many players the translator emitted, including those with no stats.
   *
   * The rows below are the non-empty ones. This is what notices the other sixty.
   */
  readonly playersTranslated: number;
  readonly warnings: readonly string[];
  readonly fatal: readonly string[];
  readonly players: readonly LedgerEntry[];
  readonly teamDefense: readonly LedgerEntry[];
}

interface RawPlayer {
  longName?: string;
  team?: string;
  teamAbv?: string;
}

/**
 * Stat lines as a plain object, sorted by key.
 *
 * Sorted because a `Map`'s iteration order is insertion order, which here is the
 * order `Object.entries` walked a provider's JSON — so an unrelated reordering
 * upstream would rewrite every ledger in the corpus and bury a real change in
 * the noise.
 */
function statsObject(lines: readonly StatLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { statKey, value } of [...lines].sort((a, b) =>
    a.statKey < b.statKey ? -1 : a.statKey > b.statKey ? 1 : 0,
  )) {
    out[statKey] = value;
  }
  return out;
}

const byRef = (a: LedgerEntry, b: LedgerEntry): number =>
  a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;

/** Build the ledger for one raw Tank01 box score. Pure; no I/O. */
export function buildLedger(raw: unknown, rules: ReadonlyMap<string, ScoringRule>): Ledger {
  const translated = translateBoxScore(raw);
  const playerStats = ((raw as { playerStats?: Record<string, RawPlayer> }).playerStats ??
    {}) as Record<string, RawPlayer>;

  const players: LedgerEntry[] = [];
  for (const [playerID, lines] of translated.players) {
    if (lines.length === 0) continue;
    players.push({
      ref: playerID,
      name: playerStats[playerID]?.longName ?? playerID,
      stats: statsObject(lines),
      milliPoints: scorePlayer(lines, rules),
    });
  }

  const teamDefense: LedgerEntry[] = [];
  for (const [teamAbv, lines] of translated.teamDefense) {
    teamDefense.push({
      ref: teamAbv,
      name: `${teamAbv} D/ST`,
      stats: statsObject(lines),
      milliPoints: scorePlayer(lines, rules),
    });
  }

  return {
    gameRef: translated.gameRef,
    playersTranslated: translated.players.size,
    warnings: [...translated.warnings],
    fatal: [...translated.fatal],
    players: players.sort(byRef),
    teamDefense: teamDefense.sort(byRef),
  };
}

/**
 * The exact bytes a ledger file holds.
 *
 * Two-space JSON with a trailing newline, which is what `prettier` produces for
 * a `.json` file — so these stay in `format:check` rather than needing a
 * `.prettierignore` entry, and a hand edit that reformats the file is caught by
 * the formatter as well as by the comparison.
 */
export function serialiseLedger(ledger: Ledger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}
