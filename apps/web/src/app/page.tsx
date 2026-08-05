export default function HomePage() {
  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight">
          Fantasy football that needs no commissioner.
        </h1>
        <p className="max-w-2xl text-white/70">
          League rules are frozen when the league is created, shown in full before you join, and
          hashed on-chain. Joining signs that hash. Nobody — not even the commissioner — can
          change the rules afterwards.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Feature title="Rules that cannot move">
          Scoring, roster, payouts, and deadlines are set once. The database rejects an update;
          the chain holds the hash you signed.
        </Feature>
        <Feature title="A pot nobody can take">
          Optional buy-ins sit in escrow until the season resolves. An unconditional timelock
          means funds can never be stuck.
        </Feature>
        <Feature title="No one declares a winner">
          The contract derives the champion from the Week 17 result. There is no sign-off step
          to corrupt.
        </Feature>
      </section>

      <section className="rounded border border-white/10 p-6">
        <h2 className="mb-2 text-lg font-medium">Pre-alpha</h2>
        <p className="text-sm text-white/60">
          Targeting the 2026 NFL season, kickoff September 9. The escrow contract is not
          audited. Read the{" "}
          <a
            className="underline"
            href="https://github.com/6figpsolseeker/rostr/blob/main/docs/RULES.md"
          >
            league rules
          </a>{" "}
          before anything else.
        </p>
      </section>
    </div>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-white/10 p-4">
      <h3 className="mb-2 font-medium">{title}</h3>
      <p className="text-sm text-white/60">{children}</p>
    </div>
  );
}
