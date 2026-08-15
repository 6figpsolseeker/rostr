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
        error?: string;
        problems?: string[];
      };

      if (!response.ok) {
        setProblems(created.problems ?? []);
        throw new Error(created.error ?? "Could not create the league");
      }

      router.push(`/leagues/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={(e) => void submit(e)} className="space-y-6">
        <label className="block text-sm">
          <span className="mb-1 block text-white/60">League name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-white/15 bg-transparent px-3 py-2"
            placeholder="The Money League"
          />
        </label>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm text-white/60">Who can join</legend>
          <div className="flex gap-2">
            {(["PRIVATE", "PUBLIC"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setVisibility(option)}
                className={`rounded px-3 py-1.5 text-sm ${
                  visibility === option
                    ? "bg-[--color-turf] text-black"
                    : "border border-white/15 text-white/70"
                }`}
              >
                {option === "PRIVATE" ? "Invite only" : "Anyone"}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block text-sm">
          <span className="mb-1 block text-white/60">Draft date and time</span>
          <input
            type="datetime-local"
            required
            value={draftAt}
            onChange={(e) => changeDraftAt(e.target.value)}
            className="rounded border border-white/15 bg-transparent px-3 py-2"
          />
          <span className="mt-1 block text-xs text-white/40">
            Frozen at creation and it cannot be moved. The draft order is drawn from the first
            Solana block at or after this moment, so nobody — including you — can know it in
            advance.
          </span>
        </label>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm text-white/60">Draft pace</legend>
          <div className="flex gap-2">
            {(["SLOW", "FAST"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => switchMode(option)}
                className={`rounded px-3 py-1.5 text-sm ${
                  mode === option
                    ? "bg-[--color-turf] text-black"
                    : "border border-white/15 text-white/70"
                }`}
              >
                {option === "SLOW" ? "Slow" : "Fast"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {clocks.map((clock) => (
              <button
                key={clock.seconds}
                type="button"
                onClick={() => setPickSeconds(clock.seconds)}
                className={`rounded px-2.5 py-1 text-xs ${
                  pickSeconds === clock.seconds
                    ? "bg-white/15 text-white"
                    : "border border-white/10 text-white/50"
                }`}
              >
                {clock.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block text-sm">
          <span className="mb-1 block text-white/60">Trade deadline</span>
          <select
            value={tradeDeadlineWeek}
            onChange={(e) => setTradeDeadlineWeek(Number(e.target.value))}
            className="rounded border border-white/15 bg-transparent px-3 py-2"
          >
            {TRADE_DEADLINE_WEEKS.map((week) => (
              <option key={week} value={week}>
                End of week {week}
                {week === 11 ? " (default)" : ""}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-white/40">
            Yours to set, once. After it passes nothing can be proposed, and an accepted trade
            whose veto window closes later expires rather than executing — otherwise an
            eliminated team could hand its roster to a contender.
          </span>
        </label>

        <fieldset className="space-y-3 rounded border border-white/10 p-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={withPot}
              disabled={!POT_MINT}
              onChange={(e) => setWithPot(e.target.checked)}
            />
            <span className={POT_MINT ? undefined : "text-white/40"}>Play for a pot</span>
          </label>

          {/*
            Offered only where there is a token to denominate it in. The server
            refuses a pot league on such a cluster, so an enabled checkbox here
            would be a form that submits and fails — and the honest failure is
            the one shown before anything is typed.
          */}
          {!POT_MINT && (
            <p className="text-xs text-white/40">
              Pot leagues are unavailable on this network — no pot token is configured for it.
              Everything else works.
            </p>
          )}

          {withPot && POT_MINT ? (
            <div className="space-y-3">
              <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                The escrow contract holding this money has <strong>not been audited</strong>. Do
                not put in more than you can lose. This warning is part of the rule set you and
                every member sign.
              </p>

              <label className="block text-sm">
                <span className="mb-1 block text-white/60">
                  Buy-in per team (USDC) — {MIN_BUY_IN_USDC} to {MAX_BUY_IN_USDC}
                </span>
                {/*
                  step is cents, not whole dollars. The program accepts any u64 between
                  the two bounds, so a step of 1 would be the interface inventing a
                  restriction the rules do not have — $12.50 is a legal pot.
                */}
                <input
                  type="number"
                  min={MIN_BUY_IN_USDC}
                  max={MAX_BUY_IN_USDC}
                  step="0.01"
                  value={buyIn}
                  onChange={(e) => setBuyIn(e.target.value)}
                  className="w-32 rounded border border-white/15 bg-transparent px-3 py-2"
                />
                <span className="mt-1 block text-xs text-white/40">
                  Any amount in that range, cents included. The ceiling is a limit on what a
                  single league can lose while the escrow is unaudited, not a price.
                </span>
              </label>

              {/*
                Two shapes, both decidable in a league of any size. The old
                five-way split paid a consolation winner and a third place, and
                neither exists in a small league — which meant the pot could
                never settle. See `NFL_DEFAULT_PAYOUT`.
              */}
              <fieldset className="block text-sm">
                <legend className="mb-1 block text-white/60">Prize</legend>
                <div className="flex flex-col gap-2">
                  {(
                    [
                      [
                        "SPLIT",
                        "Split three ways",
                        "70% champion, 20% runner-up, 10% best record",
                      ],
                      ["WINNER_TAKE_ALL", "Winner takes all", "100% to the champion"],
                    ] as const
                  ).map(([value, title, detail]) => (
                    <label key={value} className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="payoutShape"
                        value={value}
                        checked={payoutShape === value}
                        onChange={() => setPayoutShape(value)}
                        className="mt-1"
                      />
                      <span>
                        <span className="block">{title}</span>
                        <span className="block text-xs text-white/40">{detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <span className="mt-1 block text-xs text-white/40">
                  Frozen with the rest of the rules. Everyone who joins signs this split, and
                  nobody — including you — can change it afterwards.
                </span>
              </fieldset>

              <label className="block text-sm">
                <span className="mb-1 block text-white/60">Refund unlock</span>
                <input
                  type="datetime-local"
                  value={refundUnlock}
                  onChange={(e) => {
                    setRefundTouched(true);
                    setRefundUnlock(e.target.value);
                  }}
                  className="rounded border border-white/15 bg-transparent px-3 py-2"
                />
                <span className="mt-1 block text-xs text-white/40">
                  After this moment any member can withdraw their own stake, whatever state the
                  league is in. It is the guarantee that funds can never be permanently stuck —
                  set it comfortably after the championship.
                </span>
              </label>
            </div>
          ) : (
            <p className="text-xs text-white/40">
              A league with no pot plays for nothing but the record. Everything else works the
              same.
            </p>
          )}
        </fieldset>

        {error && (
          <div className="space-y-1 rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <p>{error}</p>
            {problems.length > 0 && (
              <ul className="list-inside list-disc text-xs">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || name.trim() === "" || preview === null}
          className="rounded bg-[--color-turf] px-5 py-2.5 text-sm font-medium text-black disabled:opacity-40"
        >
          {submitting ? "Creating…" : "Create league and freeze these rules"}
        </button>
      </form>

      {preview && (
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-medium">What you are freezing</h2>
            <p className="text-sm text-white/50">
              This updates as you change the settings above. The hash is what every member signs
              to join, and what goes on chain.
            </p>
          </div>
          <RulesView rules={preview} hash={hashLeagueRules(preview)} />
        </section>
      )}
    </div>
  );
}
