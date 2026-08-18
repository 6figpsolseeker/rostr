import { expectedScoreTerms, fetchOnChainScores, scoresTermMismatches } from "@rostr/escrow";
import { getLeagueRules, type SettlementAccountCheck } from "@rostr/db";
import { readOnlyEscrow } from "./escrow";
import { db } from "./db";

/**
 * Whether a league's on-chain settlement account matches the rules its members
 * signed — asked immediately before the order is drawn.
 *
 * The reasoning lives on `SettlementAccountCheck` in `@rostr/db`; this is the
 * wire. It is the only enforcement that account gets, because the program cannot
 * compare its own contents against a rules hash it sees as 32 opaque bytes.
 *
 * **Read, never recorded**, unlike `season_started_at` beside it. That one is a
 * single event a route verifies once and writes down. This is a comparison
 * against the *current* contents of an account, so a stored copy would be a
 * second source of truth about a fact whose whole value is that it came from the
 * chain — and it could only ever be stale in the unsafe direction.
 */
export function settlementAccountCheck(): SettlementAccountCheck {
  const { program } = readOnlyEscrow();

  return {
    /**
     * A missing account is a mismatch, not an absence.
     *
     * Fail closed: a league that drafts without one has no payee roster and no
     * terms to derive its result under, and by the time anyone notices the
     * season has been played. Refusing costs a commissioner one transaction
     * before the draw; the other way costs a pot that cannot be settled.
     */
    async mismatches(leagueId: string, teamCount: number): Promise<readonly string[]> {
      const stored = await getLeagueRules(db(), leagueId);
      if (!stored) return ["this league has no stored rules to compare against"];

      const onChain = await fetchOnChainScores(program, leagueId);
      if (!onChain) {
        return [
          "no settlement account exists on-chain, so this league has no payee roster and " +
            "no terms to derive its result under",
        ];
      }

      return scoresTermMismatches(onChain, expectedScoreTerms(stored.rules, teamCount));
    },
  };
}
