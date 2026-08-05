import { buildNflPprRules, NFL_DEFAULT_PAYOUT } from "@rostr/core";
import { RulesView } from "@/components/RulesView";
import { hashLeagueRules } from "@rostr/core";

/**
 * League creation.
 *
 * The preview below is the actual default rule set, rendered by the same
 * component a prospective member sees. A creator should not be able to freeze
 * rules they were never shown either.
 */
export default function NewLeaguePage() {
  const preview = buildNflPprRules({
    seasonYear: 2026,
    draft: {
      type: "SNAKE",
      mode: "SLOW",
      pickSeconds: 14_400,
      // Placeholder: the real value is chosen in the form and frozen at creation.
      scheduledAt: Math.floor(new Date("2026-08-22T18:00:00Z").getTime() / 1000),
    },
    pot: {
      tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      buyInBaseUnits: "50000000",
      payout: NFL_DEFAULT_PAYOUT,
      refundUnlockAt: Math.floor(new Date("2027-03-01T00:00:00Z").getTime() / 1000),
    },
  });

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Create a league</h1>
        <p className="max-w-2xl text-sm text-white/60">
          Everything below is frozen the moment the league is created. It cannot be amended
          afterwards except by unanimous signed consent of every member with a stake — so read
          it now rather than later.
        </p>
      </header>

      <div className="rounded border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        The creation form is not wired up yet. It needs a Supabase database and a signed-in user
        — see{" "}
        <a
          className="underline"
          href="https://github.com/6figpsolseeker/rostr/blob/main/docs/SETUP-REQUIRED.md"
        >
          SETUP-REQUIRED.md
        </a>
        . The API route exists at <code className="font-mono">POST /api/leagues</code>.
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Default rules preview</h2>
        <RulesView rules={preview} hash={hashLeagueRules(preview)} />
      </section>
    </div>
  );
}
