"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildNflPprRules,
  earliestRefundUnlock,
  hashLeagueRules,
  MAX_BUY_IN_BASE_UNITS,
  MIN_BUY_IN_BASE_UNITS,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
  NFL_DEFAULT_SCHEDULE,
  NFL_DEFAULT_SETTLEMENT,
  NFL_WINNER_TAKE_ALL_PAYOUT,
} from "@rostr/core";
import type { LeagueRules, PotRules } from "@rostr/core";
import { parseCluster, potMintFor } from "@rostr/escrow";
import { RulesView } from "@/components/RulesView";

/**
 * League creation.
 *
 * **The preview is built from the same inputs the server will use**, by the same
 * function, and its hash is shown live. So a creator watches the exact rule set
 * they are about to freeze — including the hash their members will sign — rather
 * than filling in a form and finding out afterwards.
 *
 * The server rebuilds the rules itself and never trusts anything rendered here;
 * this is a preview, not a payload. If the two ever disagreed, the hash on the
 * league page would differ from the one shown at creation, which is exactly the
 * kind of discrepancy that should be visible.
 */

const FAST_CLOCKS = [
  { label: "90 seconds", seconds: 90 },
  { label: "2 minutes", seconds: 120 },
  { label: "5 minutes", seconds: 300 },
  { label: "10 minutes", seconds: 600 },
];

const SLOW_CLOCKS = [
  { label: "1 hour", seconds: 3600 },
  { label: "4 hours", seconds: 14_400 },
  { label: "8 hours", seconds: 28_800 },
  { label: "24 hours", seconds: 86_400 },
];

/**
 * The pot token for the cluster this build targets.
 *
 * **This was hardcoded to mainnet USDC, which was a live break and not only a
 * hardening gap.** The deployment targets devnet, where that mint account does
 * not exist, so `initialize_league` — which takes the mint as a real account —
 * would have failed at account resolution the first time anyone anchored a pot
 * league there. It never surfaced because the program has not been deployed to
 * devnet yet.
 *
 * It must be the same value the server derives, because the whole creation
 * promise is that the previewed hash is the frozen hash. Both read `POT_MINTS`;
 * a build pointed at one cluster and a server at another would disagree, and
 * the preview would be a hash of terms nobody stored. `NEXT_PUBLIC_*` is
 * inlined at build time, so this is a property of the deployment, exactly as
 * `NEXT_PUBLIC_FEE_RECIPIENT` is.
 *
 * `null` where the cluster has no pot token, which disables the pot section
 * rather than previewing a league the server would refuse to create.
 */
const POT_MINT = potMintFor(
  parseCluster(process.env["NEXT_PUBLIC_SOLANA_CLUSTER"]) ?? "devnet",
  process.env["NEXT_PUBLIC_POT_MINT_LOCALNET"],
);

/**
 * Must match `FEE_RECIPIENT` on the server — see the comment where it is used.
 * Empty means no fee, which is the right default locally: better a preview that
 * honestly shows nothing than one that invents a recipient.
 */
const FEE_RECIPIENT = process.env.NEXT_PUBLIC_FEE_RECIPIENT ?? "";

/**
 * Mirrors the server's `SETTLEMENT_ORACLE`, and must equal it.
 *
 * Same arrangement as the fee recipient above and the same hazard: two values
 * set independently that have to agree, where disagreeing means the hash this
 * form previews is not the hash the server freezes. The banner at the end of the
 * submit path is what catches that — it compares the two and stops being a form
 * rather than letting a league exist whose preview was a different document.
 */
const SETTLEMENT_ORACLE = process.env.NEXT_PUBLIC_SETTLEMENT_ORACLE ?? "";

// The bounds are defined in base units, because that is what the program
// enforces. USDC's six decimals are the only reason these divide cleanly, and
// the same six decimals are why the program requires them.
const MIN_BUY_IN_USDC = MIN_BUY_IN_BASE_UNITS / 1_000_000;
const MAX_BUY_IN_USDC = MAX_BUY_IN_BASE_UNITS / 1_000_000;

/**
 * Weeks a trade deadline may fall on.
 *
 * Bounded by the regular season at the top — `validateLeagueRules` refuses
 * anything later — and started at 8 because a deadline before midseason is a
 * league that has barely played. ESPN and Sleeper both land around 12-13 by
 * calendar date; 11 is our default and the middle of this range.
 */
const TRADE_DEADLINE_WEEKS = [8, 9, 10, 11, 12, 13, 14];

/**
 * A week out, at 2pm local.
 *
 * **Derived from `now`, not typed out**, for the same reason `defaultRefundUnlock`
 * below is. It was the constant `"2026-08-22T14:00"`, with a comment naming the
 * deadline it was written for — which was fine until that date passed, and then
 * it would have proposed a draft in the past to every creator. Harmless before
 * the field locked at the draft time; league-destroying afterwards, because such
 * a league refuses its own first join and its rules can never be corrected.
 *
 * A week gives people time to be invited and join, which is the thing the draft
 * date now bounds.
 */
function defaultDraftAt(now: Date): string {
  const at = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  at.setHours(14, 0, 0, 0);
  return unixToLocalInput(Math.floor(at.getTime() / 1000));
}

function localToUnix(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

function unixToLocalInput(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * The earliest date `validateLeagueRules` will accept, for this draft date.
 *
 * **Derived, not typed out.** It was `"2027-03-01T00:00"` with a comment saying
 * "two weeks after the championship" — which was wrong by six weeks, and worse,
 * it was a constant sitting next to a draft date the commissioner can move. Push
 * the draft back a fortnight and a hardcoded refund date silently becomes
 * illegal, and the creator gets a validation error about a field they never
 * touched.
 *
 * Calling the same function the validator calls means the form cannot suggest a
 * date the server will refuse. The floor already carries sixty days of grace, so
 * offering it directly is safe rather than borderline — and a commissioner who
 * wants later can pick later.
 */
function defaultRefundUnlock(draftAt: string): string {
  const scheduledAt = localToUnix(draftAt);
  if (!Number.isFinite(scheduledAt)) return "";

  return unixToLocalInput(
    earliestRefundUnlock({
      draftScheduledAt: scheduledAt,
      regularSeasonWeeks: NFL_DEFAULT_SCHEDULE.regularSeasonWeeks,
      playoffWeeks: NFL_DEFAULT_SCHEDULE.playoffWeeks,
      payingFinalizationHours: NFL_DEFAULT_SETTLEMENT.payingFinalizationHours,
    }),
  );
}

export function CreateLeagueForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"PRIVATE" | "PUBLIC">("PRIVATE");
  // Computed once, on mount. A module-level constant would be evaluated at
  // import time and shared by every render of a long-lived server process.
  const [draftAt, setDraftAt] = useState(() => defaultDraftAt(new Date()));
  const [mode, setMode] = useState<"FAST" | "SLOW">("SLOW");
  const [pickSeconds, setPickSeconds] = useState(14_400);
  const [tradeDeadlineWeek, setTradeDeadlineWeek] = useState(11);
  const [withPot, setWithPot] = useState(false);
  const [buyIn, setBuyIn] = useState("25");
  const [payoutShape, setPayoutShape] = useState<"SPLIT" | "WINNER_TAKE_ALL">("SPLIT");
  // Seeded from the draft date, and follows it until the commissioner sets one
  // themselves. Moving the draft back a fortnight would otherwise leave a refund
  // date the server refuses, and the error would name a field they never touched.
  const [refundUnlock, setRefundUnlock] = useState(() =>
    defaultRefundUnlock(defaultDraftAt(new Date())),
  );
  const [refundTouched, setRefundTouched] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);

  /**
   * The league was created and its hash is not the one previewed above.
   *
   * Held rather than thrown, because by the time this is knowable the league
   * exists — the rules are frozen and cannot be corrected, only abandoned. So
   * this has to be loud *and* still hand over the link: an error that navigated
   * nowhere would leave a real league reachable only through browser history,
   * and there is no "my leagues" list to find it in.
   */
  const [mismatch, setMismatch] = useState<{
    id: string;
    previewed: string;
    frozen: string;
  } | null>(null);

  /**
   * Two steps, and the second is a ceremony rather than a page.
   *
   * The design splits creation into the choices and **the freeze** — read the
   * whole rule set, then sign. Keeping them in one component rather than two
   * routes is deliberate: the rules being reviewed are built from state that
   * lives here, and a route boundary would mean either serialising them through
   * the URL or rebuilding them on the other side, which is a second place for
   * the previewed hash to diverge from the frozen one.
   */
  const [step, setStep] = useState<"configure" | "freeze">("configure");

  /**
   * Gates the submit. Not decoration: `RULES.md` and this screen both promise
   * the rules are shown in full before anyone commits, and the commissioner is
   * the first person that applies to.
   */
  const [acknowledged, setAcknowledged] = useState(false);

  const clocks = mode === "FAST" ? FAST_CLOCKS : SLOW_CLOCKS;

  function changeDraftAt(next: string): void {
    setDraftAt(next);
    if (!refundTouched) setRefundUnlock(defaultRefundUnlock(next));
  }

  function switchMode(next: "FAST" | "SLOW"): void {
    setMode(next);
    // The clock lists do not overlap, so a stale value would be invalid for the
    // new mode — validation would reject it and the message would be confusing.
    setPickSeconds(next === "FAST" ? 90 : 14_400);
  }

  const pot: PotRules | null = useMemo(() => {
    if (!withPot || !POT_MINT) return null;

    const amount = Number.parseFloat(buyIn);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    return {
      tokenMint: POT_MINT,
      // USDC has six decimals. A decimal string, because this is a u64 on chain
      // and JavaScript numbers stop being exact well before a u64 does.
      buyInBaseUnits: String(Math.round(amount * 1_000_000)),
      payout:
        payoutShape === "WINNER_TAKE_ALL" ? NFL_WINNER_TAKE_ALL_PAYOUT : NFL_DEFAULT_PAYOUT,
      refundUnlockAt: localToUnix(refundUnlock),
      // The fee has to appear in the preview because the preview is the whole
      // promise: what is rendered here is what gets hashed and frozen. A pot
      // shown without its fee would be a rule set the creator never actually
      // agreed to.
      //
      // NEXT_PUBLIC_FEE_RECIPIENT must equal the server's FEE_RECIPIENT. If they
      // drift, this preview and the created league disagree — the server's value
      // is the one that binds, so the mismatch is visible rather than dangerous,
      // but it makes a liar of this screen. They are set together.
      feeBps: FEE_RECIPIENT ? NFL_DEFAULT_FEE_BPS : 0,
      feeRecipient: FEE_RECIPIENT,
      settlementOracle: SETTLEMENT_ORACLE,
    };
  }, [withPot, buyIn, refundUnlock, payoutShape]);

  const preview: LeagueRules | null = useMemo(() => {
    const scheduledAt = localToUnix(draftAt);
    if (!Number.isFinite(scheduledAt)) return null;

    try {
      return buildNflPprRules({
        seasonYear: 2026,
        draft: { type: "SNAKE", mode, pickSeconds, scheduledAt },
        league: { visibility },
        trades: { deadlineWeek: tradeDeadlineWeek },
        pot,
      }) as LeagueRules;
    } catch {
      return null;
    }
  }, [draftAt, mode, pickSeconds, visibility, tradeDeadlineWeek, pot]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setProblems([]);
    setSubmitting(true);

    try {
      const response = await fetch("/api/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          visibility,
          draftAt: localToUnix(draftAt),
          draftMode: mode,
          pickSeconds,
          tradeDeadlineWeek,
          pot: pot
            ? {
                // No `tokenMint`. The server derives it from the cluster, for
                // the same reason it derives the fee recipient — a mint the
                // caller chose is a mint the caller can pick for its freeze
                // authority. The preview above uses the identical constant, so
                // the hash shown is still the hash stored.
                buyInBaseUnits: pot.buyInBaseUnits,
                refundUnlockAt: pot.refundUnlockAt,
                payout: payoutShape,
              }
            : null,
        }),
      });

      const created = (await response.json()) as {
        id?: string;
        rulesHash?: string;
        error?: string;
        problems?: string[];
      };

      if (!response.ok) {
        setProblems(created.problems ?? []);
        throw new Error(created.error ?? "Could not create the league");
      }

      /*
        The one check this screen was missing.

        Everything above promises that the hash rendered in the freeze step is
        the hash the server stores. This file already noted that a divergence
        *would* be visible — as two different hashes on two different screens —
        and that is only true of someone who thinks to compare them. Nothing
        surfaced it at the moment it matters.

        Drift is a configuration mistake away rather than hypothetical.
        `FEE_RECIPIENT` is mirrored into `NEXT_PUBLIC_FEE_RECIPIENT`, two values
        set independently that must agree; and the mint is derived on both sides
        from `POT_MINTS`, keyed by a cluster the browser reads from
        `NEXT_PUBLIC_SOLANA_CLUSTER` and **defaults to devnet when unset**, where
        the server's `declaredCluster()` would have thrown. So an unset browser
        variable on a mainnet deployment previews a devnet mint against a mainnet
        freeze — and the symptom is a commissioner who read and acknowledged one
        document while their members sign another.

        Free leagues build `pot: null` on both sides and have no divergence
        surface at all, so this cannot fire on them.
      */
      if (previewHash !== null && created.rulesHash !== previewHash) {
        setMismatch({
          id: created.id ?? "",
          previewed: previewHash,
          frozen: created.rulesHash ?? "none returned",
        });
        setSubmitting(false);
        return;
      }

      // `replace`, not `push`, so the create page leaves the history stack.
      // Back from a league should return to wherever the commissioner came from,
      // not to the form that made it — a form that remounts empty (every piece
      // of its state is `useState`, and this is a route change) and invites a
      // second league, which cannot be deleted, only dissolved.
      router.replace(`/leagues/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const previewHash = useMemo(() => (preview ? hashLeagueRules(preview) : null), [preview]);

  /**
   * Which of the ten choices the commissioner has actually made.
   *
   * The design shows "8 set · 2 unavailable". `unavailable` is the pot pair —
   * buy-in and payout — when the cluster has no pot token, which is the honest
   * reading of a control that is disabled rather than merely untouched.
   */
  const potAvailable = POT_MINT !== null;
  const choicesSet =
    (name.trim() ? 1 : 0) + 6 + (withPot ? 2 : 0) + (potAvailable && !withPot ? 1 : 0);

  /*
    Once a league exists this screen has nothing left to offer, so it stops being
    a form.

    Rendering the banner *inside* the freeze step left "Back to the choices"
    live: pressing it landed the commissioner on a configure step whose submit
    button was permanently disabled, with the explanation no longer on screen and
    nothing saying why. The only thing worth doing now is opening the league that
    was created, so that is the only thing here.
  */
  if (mismatch) {
    return (
      <div className="mx-auto max-w-[860px]">
        <h1 className="text-[38px] font-medium leading-[1.08] tracking-[-0.03em]">
          The frozen rules are not the rules you read
        </h1>
        <p className="mt-4 max-w-[640px] text-[15.5px] leading-[1.6] text-nocturne-neutral-400">
          The league was created — that cannot be undone, and its rules can never be amended —
          but the hash the server stored differs from the one shown on the previous screen. So
          this screen did not show you the document your members will sign. Read the stored rule
          set before inviting anyone.
        </p>
        <p className="mt-4 max-w-[640px] text-[14px] leading-[1.6] text-nocturne-neutral-500">
          This almost always means the browser and the server disagree about which chain this
          deployment is on, or about the fee recipient. Both are build-time configuration and
          neither can be fixed from here.
        </p>

        <dl className="mt-6 space-y-1 font-mono text-[11.5px] break-all text-nocturne-neutral-500">
          <div>
            <dt className="inline text-nocturne-neutral-600">shown to you </dt>
            <dd className="inline">{mismatch.previewed}</dd>
          </div>
          <div>
            <dt className="inline text-nocturne-neutral-600">frozen </dt>
            <dd className="inline">{mismatch.frozen}</dd>
          </div>
        </dl>

        {mismatch.id ? (
          <a
            href={`/leagues/${mismatch.id}`}
            className="mt-8 inline-block rounded-[4px] border border-nocturne-accent px-[26px] py-3 text-[14.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Open the league and read what was stored
          </a>
        ) : null}
      </div>
    );
  }

  if (step === "freeze") {
    return (
      <div className="mx-auto max-w-[860px]">
        <button
          type="button"
          onClick={() => setStep("configure")}
          className="text-[13px] text-nocturne-neutral-500 hover:text-nocturne-text"
        >
          &larr; Back to the choices
        </button>

        <h1 className="mt-6 text-[38px] font-medium leading-[1.08] tracking-[-0.03em]">
          The freeze
        </h1>
        <p className="mt-3 text-[15.5px] leading-[1.6] text-nocturne-neutral-400">
          Where consent becomes cryptographic — read to the end, then sign.
        </p>

        <div className="mt-6 flex items-center gap-3 text-[11px] uppercase tracking-[0.14em]">
          <span className="rounded-[4px] border border-nocturne-accent/40 px-2 py-1 text-nocturne-accent-300">
            Step 1 of 2 · read
          </span>
          {previewHash ? (
            <span className="font-mono text-[11.5px] normal-case tracking-normal text-nocturne-neutral-600">
              {previewHash.slice(0, 6)}…{previewHash.slice(-4)}
            </span>
          ) : null}
        </div>

        {/*
          The rule set, rendered by the same component the league page and the
          join screen use.

          **Not a copy of the design's table.** The handoff draws every scoring
          value as literal text, and those values were already a day stale when
          it arrived — see `docs/design/STATUS.md`. `RulesView` reads
          `rules.scoring`, so this screen cannot say something the frozen
          document does not.
        */}
        <div className="mt-8 rounded-lg bg-nocturne-surface p-7 shadow-[0_0_0_1px_#292b31]">
          {preview && previewHash ? (
            <RulesView rules={preview} hash={previewHash} />
          ) : (
            <p className="text-[14px] text-nocturne-neutral-500">
              The rule set cannot be built from these choices. Go back and check the draft date.
            </p>
          )}
        </div>

        <p className="mt-8 text-[13px] text-nocturne-neutral-600">End of the rule set.</p>

        <label className="mt-6 flex items-start gap-3 text-[14.5px] leading-[1.6]">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1"
          />
          <span>
            I have read the rule set and understand it cannot be changed.
            <span className="mt-1 block text-[13px] text-nocturne-neutral-600">
              After this it cannot be amended without unanimous signed consent of every member
              holding a stake. There is no commissioner override — not now, not later.
            </span>
          </span>
        </label>

        {problems.length > 0 ? (
          <ul className="mt-6 space-y-1 text-[13.5px] text-nocturne-accent-300">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        {error ? <p className="mt-4 text-[14px] text-nocturne-accent-300">{error}</p> : null}

        <form onSubmit={(e) => void submit(e)} className="mt-8">
          <button
            type="submit"
            disabled={!acknowledged || submitting || !preview}
            className="rounded-[4px] border border-nocturne-accent px-[26px] py-3 text-[14.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:cursor-not-allowed disabled:border-nocturne-neutral-800 disabled:text-nocturne-neutral-600"
          >
            {submitting ? "Freezing…" : "Freeze and create the league"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-[38px] font-medium leading-[1.08] tracking-[-0.03em]">
        Create a league
      </h1>
      <p className="mt-3 text-[15.5px] text-nocturne-neutral-400">
        Ten values are yours · everything else is disclosed, not configured
      </p>

      <div className="mt-11 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-start">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setStep("freeze");
          }}
          className="space-y-11"
        >
          <Group index="01" title="League">
            <Field
              label="League name"
              hint="Renameable until Week 1, then frozen with everything else."
            >
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dynasty of Dropped Passes"
                className="w-full rounded-[4px] border border-nocturne-neutral-800 bg-transparent px-3 py-2.5 text-[14.5px] outline-none focus:border-nocturne-accent"
              />
            </Field>

            <Field label="Visibility" hint="Private is invite only. Public is open join.">
              <Choices
                options={[
                  { value: "PRIVATE", label: "Private" },
                  { value: "PUBLIC", label: "Public" },
                ]}
                value={visibility}
                onChange={(v) => setVisibility(v as "PRIVATE" | "PUBLIC")}
              />
            </Field>
          </Group>

          <Group index="02" title="Draft" note="Snake, and the order is not yours to draw">
            <Field
              label="Scheduled draft time"
              hint="The order is drawn from the first Solana block at or after this moment, so nobody — including you — can know it in advance. The field locks then too: nobody can join after it."
            >
              <input
                type="datetime-local"
                required
                value={draftAt}
                onChange={(e) => changeDraftAt(e.target.value)}
                className="rounded-[4px] border border-nocturne-neutral-800 bg-transparent px-3 py-2.5 text-[14.5px] outline-none focus:border-nocturne-accent"
              />
            </Field>

            <Field label="Pace" hint="Fast runs in one sitting. Slow runs over days.">
              <Choices
                options={[
                  { value: "FAST", label: "Fast" },
                  { value: "SLOW", label: "Slow" },
                ]}
                value={mode}
                onChange={(v) => switchMode(v as "FAST" | "SLOW")}
              />
            </Field>

            <Field
              label="Pick clock"
              hint="90 seconds is the floor. The clock is hard — expiry always results in a pick, so a draft never stalls."
            >
              <Choices
                options={clocks.map((c) => ({ value: String(c.seconds), label: c.label }))}
                value={String(pickSeconds)}
                onChange={(v) => setPickSeconds(Number(v))}
              />
            </Field>
          </Group>

          <Group index="03" title="Field" note="Up to 12 teams, minimum 2 humans">
            <p className="text-[13.5px] leading-[1.62] text-nocturne-neutral-500">
              One bot is permitted, and only to square an odd field — never in a league with a
              pot, because a bot has no wallet and paid no buy-in. Add it from the league page
              once you know how many people turned up.
            </p>
          </Group>

          <Group index="04" title="Transactions and lineups">
            <Field
              label="Trade deadline"
              hint="Weeks 8–14. Without a deadline an eliminated team can hand its roster to a contender."
            >
              <select
                value={tradeDeadlineWeek}
                onChange={(e) => setTradeDeadlineWeek(Number(e.target.value))}
                className="rounded-[4px] border border-nocturne-neutral-800 bg-nocturne-surface px-3 py-2.5 text-[14.5px] outline-none focus:border-nocturne-accent"
              >
                {TRADE_DEADLINE_WEEKS.map((week) => (
                  <option key={week} value={week}>
                    End of Week {week}
                    {week === 11 ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Autofill ranking"
              hint="How an empty slot is filled at lock, scored under this league's own rules."
            >
              <p className="text-[14px] text-nocturne-neutral-400">
                This week&rsquo;s projection
              </p>
            </Field>
          </Group>

          <Group index="05" title="The pot" note={potAvailable ? "Optional" : "Not live yet"}>
            <Choices
              options={[
                { value: "no", label: "No pot" },
                { value: "yes", label: "Play for a pot" },
              ]}
              value={withPot ? "yes" : "no"}
              onChange={(v) => setWithPot(v === "yes")}
              disabled={!potAvailable}
            />

            {!potAvailable ? (
              <p className="mt-3 text-[13.5px] leading-[1.62] text-nocturne-neutral-500">
                This build has no pot token configured, so a pot league cannot be previewed here
                — and the deposit button stays shut on mainnet until the program can pay a pot
                back out.
              </p>
            ) : null}

            {withPot ? (
              <div className="mt-5 space-y-5">
                <Field
                  label="Buy-in per member"
                  hint={`Between $${MIN_BUY_IN_USDC} and $${MAX_BUY_IN_USDC}, enforced on chain.`}
                >
                  <input
                    value={buyIn}
                    onChange={(e) => setBuyIn(e.target.value)}
                    inputMode="decimal"
                    className="w-32 rounded-[4px] border border-nocturne-neutral-800 bg-transparent px-3 py-2.5 text-[14.5px] outline-none focus:border-nocturne-accent"
                  />
                </Field>

                <Field
                  label="Payout shape"
                  hint="The champion holds the largest single share either way. A 1% fee is taken once, at settlement."
                >
                  <Choices
                    options={[
                      { value: "SPLIT", label: "70 / 20 / 10" },
                      { value: "WINNER_TAKE_ALL", label: "Winner takes all" },
                    ]}
                    value={payoutShape}
                    onChange={(v) => setPayoutShape(v as "SPLIT" | "WINNER_TAKE_ALL")}
                  />
                </Field>

                <Field
                  label="Refund unlocks"
                  hint="The unconditional escape hatch. It cannot open before the season can settle, and it is never charged a fee."
                >
                  <input
                    type="datetime-local"
                    value={refundUnlock}
                    onChange={(e) => {
                      setRefundUnlock(e.target.value);
                      setRefundTouched(true);
                    }}
                    className="rounded-[4px] border border-nocturne-neutral-800 bg-transparent px-3 py-2.5 text-[14.5px] outline-none focus:border-nocturne-accent"
                  />
                </Field>
              </div>
            ) : null}
          </Group>

          <button
            type="submit"
            disabled={!name.trim() || !preview}
            className="rounded-[4px] border border-nocturne-accent px-[26px] py-3 text-[14.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:cursor-not-allowed disabled:border-nocturne-neutral-800 disabled:text-nocturne-neutral-600"
          >
            Review and freeze
          </button>
        </form>

        {/* The rail: what you cannot set, which is most of it. */}
        <aside className="space-y-6 lg:sticky lg:top-8">
          <section className="rounded-lg bg-nocturne-surface p-6 shadow-[0_0_0_1px_#292b31]">
            <p className="text-[11px] uppercase tracking-[0.14em] text-nocturne-neutral-600">
              Not yours to set
            </p>
            <dl className="mt-4 space-y-3 text-[13.5px] leading-[1.55]">
              {[
                ["Scoring", "Full PPR. Frozen at creation, like everything here."],
                [
                  "Roster",
                  "QB, 2 RB, 2 WR, TE, FLEX, K, DEF. Nine starters, five bench, two IR.",
                ],
                ["Season", "Weeks 1–14, playoffs 15–17, championship in 17."],
                ["Tiebreakers", "Fixed and deterministic. A coin flip cannot decide a pot."],
                ["Waivers", "Rolling priority. Win a claim, go to the back."],
                [
                  "Trade veto",
                  "48-hour window, one third of uninvolved managers. You get no override — not now, not later.",
                ],
                [
                  "Fee",
                  "1% of the pot, once, at settlement. Nothing on a deposit, nothing on a refund.",
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-nocturne-neutral-500">{label}</dt>
                  <dd className="text-nocturne-neutral-400">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded-lg bg-nocturne-surface p-6 shadow-[0_0_0_1px_#292b31]">
            <div className="flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-[0.14em] text-nocturne-neutral-600">
                Rule set
              </p>
              <span className="text-[11.5px] text-nocturne-neutral-600">
                {choicesSet} set{potAvailable ? "" : " · 2 unavailable"}
              </span>
            </div>
            <dl className="mt-4 space-y-2 text-[13px]">
              <Summary label="Name" value={name.trim() || "—"} />
              <Summary
                label="Visibility"
                value={visibility === "PRIVATE" ? "Private" : "Public"}
              />
              <Summary label="Draft" value={draftAt.replace("T", ", ")} />
              <Summary
                label="Pace and clock"
                value={`${mode === "FAST" ? "Fast" : "Slow"} · ${
                  clocks.find((c) => c.seconds === pickSeconds)?.label ?? ""
                }`}
              />
              <Summary label="Trade deadline" value={`End of Week ${tradeDeadlineWeek}`} />
              <Summary label="Pot" value={withPot ? `$${buyIn} buy-in` : "None"} />
              <Summary
                label="Rules hash"
                value={
                  previewHash
                    ? `${previewHash.slice(0, 6)}…${previewHash.slice(-4)}`
                    : "computed at freeze"
                }
              />
            </dl>
            <p className="mt-4 text-[12.5px] leading-[1.55] text-nocturne-neutral-600">
              This is the document that gets hashed. Members read it in full before joining.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Group({
  index,
  title,
  note,
  children,
}: {
  index: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11.5px] text-nocturne-accent-600">{index}</span>
        <h2 className="text-[19px] font-medium tracking-[-0.018em]">{title}</h2>
        {note ? <span className="text-[12.5px] text-nocturne-neutral-600">{note}</span> : null}
      </div>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-[13px] text-nocturne-neutral-500">{label}</p>
      {children}
      {hint ? (
        <p className="mt-2 max-w-[560px] text-[12.5px] leading-[1.6] text-nocturne-neutral-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Choices({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`rounded-[4px] border px-[14px] py-2 text-[13.5px] transition-colors ${
            value === option.value
              ? "border-nocturne-accent text-nocturne-accent-200"
              : "border-nocturne-neutral-800 text-nocturne-neutral-400 hover:text-nocturne-text"
          } disabled:cursor-not-allowed disabled:border-nocturne-neutral-900 disabled:text-nocturne-neutral-700`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-nocturne-neutral-600">{label}</dt>
      <dd className="text-right text-nocturne-neutral-300">{value}</dd>
    </div>
  );
}
