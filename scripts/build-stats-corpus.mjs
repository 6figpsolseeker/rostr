/**
 * Regenerate the scoring conformance corpus ledgers.
 *
 * One file per corpus game, holding every stat line the Tank01 translator
 * produced and what our own scoring table pays for it. **Generated, never
 * edited** — a hand-written expectation is a third implementation of the scoring
 * table with no tests of its own, and it drifts.
 *
 *   pnpm corpus:stats
 *
 * Offline. This reads the box scores already on disk and writes ledgers beside
 * them; capturing a *new* game is a different command (`pnpm stats:corpus-sync`)
 * because that one costs a metered call.
 *
 * `corpus.test.ts` fails when a checked-in ledger no longer matches what the
 * code produces, which is the signal to run this. **Read the diff before
 * committing it.** A changed number here is somebody's score moving: in a paying
 * week that is money, and because a finalised week is never rescored it would be
 * permanent. Running this to make a red suite go quiet is the exact reflex the
 * corpus exists to prevent, which is why it is a separate command and why
 * nothing in CI invokes it.
 */

import { indexScoringRules, NFL_PPR_SCORING } from "../packages/core/dist/index.js";
import { buildLedger, serialiseLedger } from "../packages/stats/dist/corpus/ledger.js";
import {
  ledgerPath,
  readBoxScore,
  readManifest,
} from "../packages/stats/dist/corpus/fixtures.js";
import { writeFileSync } from "node:fs";

const rules = indexScoringRules(NFL_PPR_SCORING);
const manifest = readManifest();

for (const game of manifest.games) {
  const ledger = buildLedger(readBoxScore(game.boxScore), rules);
  const target = ledgerPath(game.gameRef);

  writeFileSync(target, serialiseLedger(ledger), "utf8");

  const warned = ledger.warnings.length;
  process.stdout.write(
    `wrote ${game.gameRef}  ${ledger.players.length} players, ` +
      `${ledger.teamDefense.length} units` +
      `${warned > 0 ? `, ${warned} warning(s)` : ""}\n`,
  );
}
