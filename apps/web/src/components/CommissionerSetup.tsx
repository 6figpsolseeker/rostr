import type { CommissionerSetupView, SetupBlocker, SetupStepKey } from "@/lib/setup";
import { withZone } from "@/lib/when";

/**
 * The commissioner's own checklist, on the league page.
 *
 * Creating a league seats nobody (#165): `createLeague` writes the rules and
 * stops, because joining is a wallet signature over the rules hash and a league
 * is unanchored at the instant it is created. So the person who just made this
 * league is not in it, every league-scoped tab 404s at them, and before this
 * nothing on any screen said why.
 *
 * **Presentation only.** Which step is owed — and whether it can still be taken
 * at all — is decided by `commissionerSetup` in `lib/setup.ts`, where a test can
 * reach it. `apps/web` cannot render a component in a test, so a decision made in
 * this file would be verified only by being run in production. That is the same
 * reasoning that put `expectedTermsFromRules` in `@rostr/escrow` and the lobby's
 * view model in `lib/lobby.ts`, and in the `@rostr/escrow` case both defects
 * review found were in the mapping rather than in the rule.
 *
 * It points at controls rather than carrying any: `AnchorPanel` and `JoinPanel`
 * are further down the same page, below the full rule set, and each already
 * knows how to do its own step. A button here would be a second implementation
 * of the step it duplicates.
 */

const COPY: Record<SetupStepKey, { title: string; detail: string }> = {
  ANCHOR: {
    title: "Anchor the rules on-chain",
    detail:
      "Your wallet, one transaction. Until the hash is on-chain nobody can check that these " +
      "rules are fixed, so nobody can join — not your members, and not you.",
  },
  LINK: {
    title: "Prove a wallet is yours",
    detail:
      "One signature over a message we issue. It moves no funds. Without it, linking a wallet " +
      "would be typing an address, and anyone could claim one.",
  },
  SEAT: {
    title: "Sign the rules and take your seat",
    detail:
      "The same signature every other member gives, over the same hash. There is no flag that " +
      "seats a commissioner without one — consent here is cryptographic or it is nothing.",
  },
  ONCHAIN: {
    title: "Record your membership on-chain",
    detail:
      "One approval, which also stakes your buy-in if this league has a pot. Both or neither.",
  },
};

const BLOCKED: Record<SetupBlocker["code"], string> = {
  LEAGUE_CLOSED: "it is no longer forming",
  FIELD_LOCKED: "its draft time has passed and the field is locked",
  LEAGUE_FULL: "every seat is taken",
};

export function CommissionerSetup({
  setup,
  fieldLocksAt,
}: {
  setup: CommissionerSetupView;
  /**
   * The scheduled draft, from the frozen rules — the instant the field locks.
   *
   * Said out loud because the failure it guards against is silent and permanent:
   * migration `0028` refuses every `teams` INSERT from this moment, so a
   * commissioner who stalls at any step above ends up locked out of their own
   * league, with a draft that answers `NO_TEAMS` and no way to dissolve it
   * (#163). Rules are immutable, so the date cannot be moved.
   */
  fieldLocksAt: Date;
}) {
  /*
    The dead end, reported rather than dressed up as a to-do.

    Nothing in this app moves a league out of `FORMING` when its draft time
    passes, so a checklist that only counted steps would keep naming "take your
    seat" as the next action on a league nobody can join — beside a `JoinPanel`
    saying the opposite. This is the state #165 warns about, arrived at.
  */
  if (setup.blocker) {
    return (
      <section className="space-y-4 rounded-lg border border-red-500/30 bg-red-500/[0.04] p-6">
        <h2 className="text-[19px] font-medium tracking-[-0.018em]">
          You are not a member of this league
        </h2>
        <p className="max-w-[640px] text-[14px] leading-[1.62] text-nocturne-neutral-400">
          Creating a league does not join it — joining is a signature over the rules hash, and
          there is no way to sign on your behalf. That signature can no longer be given here,
          because {BLOCKED[setup.blocker.code]}
          {setup.blocker.code === "LEAGUE_CLOSED"
            ? ` (${setup.blocker.state.toLowerCase().replace("_", " ")})`
            : ""}
          .
        </p>
        <p className="max-w-[640px] text-[13px] leading-[1.6] text-nocturne-neutral-500">
          The league&rsquo;s rules are frozen and its draft time cannot be moved, so this cannot
          be undone from here. A league cannot be deleted either — there is no dissolve in the
          product yet (#163). Start a new league rather than waiting on this one.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-5 rounded-lg border border-nocturne-accent/30 bg-nocturne-accent/[0.03] p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[19px] font-medium tracking-[-0.018em]">Finish setting up</h2>
        <span className="text-[11px] uppercase tracking-[0.14em] text-nocturne-neutral-600">
          {setup.remaining} of {setup.items.length} left
        </span>
      </div>

      {/*
        Two intros, because one of them would be a lie half the time.

        This said "It has no members yet — including you" unconditionally, which
        is false on a league other people have already joined — and it rendered
        four lines under a subtitle reading `12/12 teams`. Neither sentence
        claims anything about anybody else's seats now.
      */}
      <p className="max-w-[640px] text-[14px] leading-[1.62] text-nocturne-neutral-400">
        {setup.seated ? (
          <>
            Your seat is taken and your consent is recorded here. One step left, and it is the
            one that puts your membership somewhere nobody &mdash; us included &mdash; can
            quietly change it.
          </>
        ) : (
          <>
            The league exists and its rules are frozen.{" "}
            <strong className="font-medium text-nocturne-text">You are not in it yet</strong>.
            Creating a league does not join it, because joining is a signature over the rules
            hash, and there is no way to sign on your behalf.
          </>
        )}
      </p>

      <ol className="space-y-3">
        {setup.items.map((item, index) => {
          const copy = COPY[item.key];

          return (
            <li key={item.key} className="flex gap-3">
              <span
                aria-hidden
                className={`mt-[3px] flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border text-[11px] ${
                  item.done
                    ? "border-nocturne-accent/50 text-nocturne-accent-300"
                    : item.current
                      ? "border-nocturne-accent text-nocturne-accent-200"
                      : "border-nocturne-neutral-800 text-nocturne-neutral-600"
                }`}
              >
                {item.done ? "✓" : index + 1}
              </span>
              <div>
                <p
                  className={`text-[14.5px] ${
                    item.done
                      ? "text-nocturne-neutral-600 line-through decoration-nocturne-neutral-700"
                      : item.current
                        ? "text-nocturne-text"
                        : "text-nocturne-neutral-500"
                  }`}
                >
                  {copy.title}
                  {item.current ? (
                    <span className="ml-2 text-[11px] uppercase tracking-[0.14em] text-nocturne-accent-300">
                      next
                    </span>
                  ) : null}
                </p>
                {/*
                  The reasoning is shown for the step being asked for and hidden
                  for the rest. All four at once is a wall of text at the top of
                  the screen; none at all makes four wallet interactions look
                  like bureaucracy rather than the thing being bought.
                */}
                {item.current ? (
                  <p className="mt-1 max-w-[560px] text-[13px] leading-[1.6] text-nocturne-neutral-500">
                    {copy.detail}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {/*
        Only while a seat is still owed. A commissioner who has one is past the
        deadline this warns about, and repeating it would read as a threat
        against the one step the lock does not touch.
      */}
      {setup.seated ? null : (
        <p className="text-[12.5px] leading-[1.6] text-nocturne-neutral-600">
          The controls are below the rule set. All of it has to be done before the draft,{" "}
          {withZone(fieldLocksAt)} — the field locks at that moment and nobody can join
          afterwards, including you, on your own league.
        </p>
      )}
    </section>
  );
}
