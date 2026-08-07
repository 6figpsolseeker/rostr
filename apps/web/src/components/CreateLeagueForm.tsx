"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildNflPprRules,
  hashLeagueRules,
  MAX_BUY_IN_BASE_UNITS,
  MIN_BUY_IN_BASE_UNITS,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_PAYOUT,
} from "@rostr/core";
import type { LeagueRules, PotRules } from "@rostr/core";
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

/** USDC on mainnet. The only token offered for now — one pot, one token. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

/** Two weeks after the championship, so a stuck league can always be unwound. */
const DEFAULT_REFUND_UNLOCK = "2027-03-01T00:00";

function localToUnix(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

export function CreateLeagueForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"PRIVATE" | "PUBLIC">("PRIVATE");
  const [draftAt, setDraftAt] = useState("2026-08-22T14:00");
  const [mode, setMode] = useState<"FAST" | "SLOW">("SLOW");
  const [pickSeconds, setPickSeconds] = useState(14_400);
  const [withPot, setWithPot] = useState(false);
  const [buyIn, setBuyIn] = useState("25");
  const [refundUnlock, setRefundUnlock] = useState(DEFAULT_REFUND_UNLOCK);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);

  const clocks = mode === "FAST" ? FAST_CLOCKS : SLOW_CLOCKS;

  function switchMode(next: "FAST" | "SLOW"): void {
    setMode(next);
    // The clock lists do not overlap, so a stale value would be invalid for the
    // new mode — validation would reject it and the message would be confusing.
    setPickSeconds(next === "FAST" ? 90 : 14_400);
  }

  const pot: PotRules | null = useMemo(() => {
    if (!withPot) return null;

    const amount = Number.parseFloat(buyIn);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    return {
      tokenMint: USDC_MINT,
      // USDC has six decimals. A decimal string, because this is a u64 on chain
      // and JavaScript numbers stop being exact well before a u64 does.
      buyInBaseUnits: String(Math.round(amount * 1_000_000)),
      payout: NFL_DEFAULT_PAYOUT,
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
  }, [withPot, buyIn, refundUnlock]);

  const preview: LeagueRules | null = useMemo(() => {
    const scheduledAt = localToUnix(draftAt);
    if (!Number.isFinite(scheduledAt)) return null;

    try {
      return buildNflPprRules({
        seasonYear: 2026,
        draft: { type: "SNAKE", mode, pickSeconds, scheduledAt },
        league: { visibility },
        pot,
      }) as LeagueRules;
    } catch {
      return null;
    }
  }, [draftAt, mode, pickSeconds, visibility, pot]);

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
          pot: pot
            ? {
                tokenMint: pot.tokenMint,
                buyInBaseUnits: pot.buyInBaseUnits,
                refundUnlockAt: pot.refundUnlockAt,
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
            onChange={(e) => setDraftAt(e.target.value)}
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

        <fieldset className="space-y-3 rounded border border-white/10 p-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={withPot}
              onChange={(e) => setWithPot(e.target.checked)}
            />
            <span>Play for a pot</span>
          </label>

          {withPot ? (
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

              <label className="block text-sm">
                <span className="mb-1 block text-white/60">Refund unlock</span>
                <input
                  type="datetime-local"
                  value={refundUnlock}
                  onChange={(e) => setRefundUnlock(e.target.value)}
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
