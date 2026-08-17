"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The lobby, in its two states: before the draw and after it.
 *
 * Everything shown here is passed in already computed by `lib/lobby.ts`, which
 * is testable where a component is not. This file owns the countdown, the two
 * buttons and the copy — no arithmetic about the snake, the order or the seed.
 */

export interface LobbySeatView {
  readonly teamId: string;
  readonly name: string;
  readonly isBot: boolean;
  readonly isYou: boolean;
  readonly isCommissioner: boolean;
  readonly position: number | null;
  readonly picks: readonly string[];
}

export interface DraftLobbyProps {
  readonly leagueId: string;
  readonly phase: "BEFORE_DRAW" | "DRAWN";
  /** ISO, both from the server — see the countdown note below. */
  readonly scheduledAt: string;
  readonly serverNow: string;
  readonly seats: readonly LobbySeatView[];
  readonly humans: number;
  readonly bots: number;
  readonly minHumans: number;
  readonly pickSeconds: number;
  readonly rounds: number;
  readonly drawBlocker:
    | { readonly code: "NOT_COMMISSIONER" }
    | { readonly code: "TOO_EARLY" }
    | { readonly code: "BELOW_MIN_HUMANS"; readonly humans: number; readonly required: number }
    | { readonly code: "ALREADY_DRAWN" }
    | null;
  readonly verification: {
    readonly slot: number;
    readonly blockhash: string;
    readonly seed: string;
    readonly drawnAt: string;
    readonly explanation: string;
  } | null;
  readonly yourPicks: readonly number[];
  readonly isCommissioner: boolean;
  readonly draftStarted: boolean;
}

const ET = "America/New_York";

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

const stamp = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: ET,
    dateStyle: "medium",
    timeStyle: "medium",
  });

const ordinal = (n: number): string => {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

/**
 * Counts down to `targetIso` against the **server's** clock.
 *
 * The server sends its own `now` with the payload and only the *elapsed* time
 * since this component mounted is taken locally, because elapsed time stays
 * accurate on a machine whose absolute clock is wrong. The draft room enforces
 * the same rule for the pick clock, where the cost of getting it wrong is a
 * browser locking itself out of the whole draft; here it is only a wrong-looking
 * countdown, since the server refuses an early draw either way.
 */
function useCountdown(targetIso: string, serverNowIso: string): number {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const mountedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - mountedAt), 250);
    return () => clearInterval(timer);
  }, [serverNowIso]);

  const serverNow = new Date(serverNowIso).getTime() + elapsedMs;
  return Math.max(0, new Date(targetIso).getTime() - serverNow);
}

const duration = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

export function DraftLobby(props: DraftLobbyProps) {
  const remaining = useCountdown(props.scheduledAt, props.serverNow);

  return props.phase === "BEFORE_DRAW" ? (
    <BeforeDraw {...props} remaining={remaining} />
  ) : (
    <Drawn {...props} />
  );
}

// ---------------------------------------------------------------------------
// State 1 — before the draw
// ---------------------------------------------------------------------------

function BeforeDraw(props: DraftLobbyProps & { remaining: number }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-8">
        <section className="rounded-[14px] border border-nocturne-neutral-800 bg-nocturne-surface p-7">
          <p className="text-[10.5px] uppercase tracking-[0.14em] text-nocturne-neutral-500">
            Waiting for the draw
          </p>
          <p className="mt-3 text-[76px] font-medium leading-none tracking-[-0.04em] tabular-nums">
            {duration(props.remaining)}
          </p>

          <h2 className="mt-7 text-[19px] font-medium tracking-[-0.018em]">
            The order does not exist yet.
          </h2>
          <div className="mt-3 space-y-4 text-[13.5px] leading-relaxed text-nocturne-neutral-400">
            <p>
              At {clockTime(props.scheduledAt)} the field locks and the order is drawn from the
              first Solana block produced at or after that instant. That block has not been
              produced. Nobody can know the order in advance — not the commissioner, not rostr,
              not you.
            </p>
            <p>
              This is why the seed is not fixed in advance. If it were, a commissioner could add
              a bot, compute the resulting order on their own machine, remove it, add a
              differently-named one, and repeat until the order suited them — every order
              genuinely correct, the published one entirely normal-looking. They would simply
              have re-rolled in private.
            </p>
            <p>
              The draw happens once. The database rejects a second one, positions cannot be
              edited, and the field locks the instant the scheduled time passes — no team may
              join afterwards, and a late friend cannot be squeezed in.
            </p>
          </div>

          <DrawControl {...props} />
        </section>

        <Seats seats={props.seats} humans={props.humans} bots={props.bots} drawn={false} />
      </div>

      <aside className="space-y-4 lg:sticky lg:top-[22px] lg:self-start">
        <Facts {...props} />
      </aside>
    </div>
  );
}

function DrawControl(props: DraftLobbyProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A member is not shown a control that was never theirs. The commissioner
  // chooses *when*, and the copy above has already said that is all they choose.
  if (props.drawBlocker?.code === "NOT_COMMISSIONER") return null;
  if (props.drawBlocker?.code === "ALREADY_DRAWN") return null;

  const blocked = props.drawBlocker !== null;

  async function draw() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/leagues/${props.leagueId}/draft/draw`, {
        method: "POST",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "The draw failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("The draw could not be reached. Nothing was drawn; try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-7 border-t border-nocturne-neutral-800 pt-6">
      <button
        type="button"
        onClick={() => void draw()}
        disabled={blocked || busy}
        className="rounded-[4px] border border-nocturne-accent px-[18px] py-[10px] text-[13.5px] text-nocturne-accent transition-colors hover:bg-nocturne-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nocturne-accent disabled:cursor-not-allowed disabled:border-nocturne-neutral-800 disabled:text-nocturne-neutral-600"
      >
        {busy ? "Drawing…" : "Draw the order"}
      </button>

      {/*
        The reason sits at full contrast beside a dimmed button. Dimming the row
        of copy is what the design system forbids: the affordance carries the
        disabled state, the explanation does not.
      */}
      {props.drawBlocker?.code === "TOO_EARLY" && (
        <p className="mt-3 text-[13px] text-nocturne-neutral-400">
          Not yet. The block this league will use has not been produced — the draw opens at{" "}
          {clockTime(props.scheduledAt)}.
        </p>
      )}
      {props.drawBlocker?.code === "BELOW_MIN_HUMANS" && (
        <p className="mt-3 text-[13px] text-nocturne-neutral-400">
          {props.drawBlocker.humans} of {props.drawBlocker.required} managers have joined. A bot
          cannot fill the gap — the draw needs {props.drawBlocker.required} people.
        </p>
      )}
      {error && <p className="mt-3 text-[13px] text-nocturne-accent-300">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// State 2 — the draw
// ---------------------------------------------------------------------------

function Drawn(props: DraftLobbyProps) {
  const you = props.seats.find((seat) => seat.isYou);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_452px]">
      <div className="space-y-8">
        <section className="rounded-[14px] border border-nocturne-neutral-800 bg-nocturne-surface p-7">
          <p className="text-[10.5px] uppercase tracking-[0.14em] text-nocturne-neutral-500">
            Drawn from block {props.verification?.slot.toLocaleString("en-US")}
          </p>
          {you?.position != null && (
            <h2 className="mt-3 text-[34px] font-medium tracking-[-0.026em]">
              You pick {ordinal(you.position)}.
            </h2>
          )}
          <p className="mt-3 text-[13.5px] leading-relaxed text-nocturne-neutral-400">
            The order came from the first Solana block produced at or after{" "}
            {clockTime(props.scheduledAt)}. It was drawn once, the field is locked, and no
            position can be edited — the database refuses both.
          </p>

          <div className="mt-7 overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-[13.5px]">
              <caption className="pb-3 text-left text-[10.5px] uppercase tracking-[0.14em] text-nocturne-neutral-500">
                The order · snake, reverses every round
              </caption>
              <tbody>
                {props.seats.map((seat) => (
                  <tr
                    key={seat.teamId}
                    className={
                      seat.isYou
                        ? "border-t border-nocturne-neutral-800 bg-nocturne-accent/[0.09]"
                        : "border-t border-nocturne-neutral-800"
                    }
                  >
                    <td className="w-12 py-[10px] pl-3 font-mono text-nocturne-neutral-500 tabular-nums">
                      {String(seat.position ?? 0).padStart(2, "0")}
                    </td>
                    <td className="py-[10px]">
                      {seat.name}
                      {seat.isYou && (
                        <span className="ml-2 text-[11px] text-nocturne-neutral-500">you</span>
                      )}
                      {seat.isBot && (
                        <span className="ml-2 text-[11px] text-nocturne-neutral-500">bot</span>
                      )}
                    </td>
                    <td className="py-[10px] pr-3 text-right font-mono text-nocturne-neutral-400 tabular-nums">
                      {seat.picks.join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {props.yourPicks.length === 2 && (
            <p className="mt-4 text-[12px] text-nocturne-neutral-500">
              {props.seats.length} teams, so round 2 runs{" "}
              {String(props.seats.length).padStart(2, "0")} back to 01. Your first two picks are{" "}
              {ordinal(props.yourPicks[0]!)} and {ordinal(props.yourPicks[1]!)} overall.
            </p>
          )}

          <EnterRoom {...props} />
        </section>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-[22px] lg:self-start">
        {props.verification && <Verification verification={props.verification} />}
      </aside>
    </div>
  );
}

function EnterRoom(props: DraftLobbyProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Anyone may walk into the room; only the commissioner starts the clock. The
  // two are deliberately separate — the room is readable while the lobby is
  // still up, and nobody's ninety seconds start because a page was opened.
  if (!props.isCommissioner || props.draftStarted) {
    return (
      <div className="mt-7 border-t border-nocturne-neutral-800 pt-6">
        <a
          href={`/leagues/${props.leagueId}/draft`}
          className="inline-block rounded-[4px] border border-nocturne-accent px-[18px] py-[10px] text-[13.5px] text-nocturne-accent transition-colors hover:bg-nocturne-accent/10"
        >
          Enter the draft room
        </a>
        {!props.draftStarted && (
          <p className="mt-3 text-[13px] text-nocturne-neutral-400">
            The clock starts when the commissioner opens the draft.
          </p>
        )}
      </div>
    );
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/leagues/${props.leagueId}/draft/start`, {
        method: "POST",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "The draft could not be started.");
        return;
      }
      router.push(`/leagues/${props.leagueId}/draft`);
    } catch {
      setError("The draft could not be started. Nothing changed; try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-7 border-t border-nocturne-neutral-800 pt-6">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className="rounded-[4px] border border-nocturne-accent px-[18px] py-[10px] text-[13.5px] text-nocturne-accent transition-colors hover:bg-nocturne-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nocturne-accent disabled:cursor-not-allowed disabled:border-nocturne-neutral-800 disabled:text-nocturne-neutral-600"
      >
        {busy ? "Opening…" : "Open the draft room"}
      </button>
      <p className="mt-3 text-[13px] text-nocturne-neutral-400">
        This starts the first pick clock. Everyone can read the order and the verification below
        until you do.
      </p>
      {error && <p className="mt-3 text-[13px] text-nocturne-accent-300">{error}</p>}
    </div>
  );
}

function Verification({
  verification,
}: {
  verification: NonNullable<DraftLobbyProps["verification"]>;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <section className="rounded-[14px] border border-nocturne-neutral-800 bg-nocturne-surface p-6">
      <p className="text-[10.5px] uppercase tracking-[0.14em] text-nocturne-neutral-500">
        Check it yourself
      </p>
      <h2 className="mt-2 text-[19px] font-medium tracking-[-0.018em]">Verifiable</h2>
      <p className="mt-3 text-[13px] leading-relaxed text-nocturne-neutral-400">
        Look the slot up on any Solana explorer. Confirm its block time is at or after the
        scheduled draft time and that the block before it is earlier — that makes it the only
        block this league could have used. Then recompute the shuffle.
      </p>

      <dl className="mt-5 space-y-3 text-[13px]">
        <Row label="Slot" value={verification.slot.toLocaleString("en-US")} mono />
        <Row label="Blockhash" value={verification.blockhash} mono wrap />
        <Row label="Seed" value={verification.seed} mono wrap />
        <Row label="Recorded" value={stamp(verification.drawnAt)} />
      </dl>

      <pre className="mt-5 overflow-x-auto whitespace-pre-wrap rounded-[8px] border border-nocturne-neutral-800 bg-nocturne-bg p-4 font-mono text-[11.5px] leading-relaxed text-nocturne-neutral-400">
        {verification.explanation}
      </pre>

      <div className="mt-4 flex flex-wrap gap-3">
        <a
          href={`https://explorer.solana.com/block/${verification.slot}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-[4px] border border-nocturne-neutral-800 px-[14px] py-2 text-[13px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
        >
          Open in explorer
        </a>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(verification.explanation).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          className="rounded-[4px] border border-nocturne-neutral-800 px-[14px] py-2 text-[13px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nocturne-accent"
        >
          {copied ? "Copied" : "Copy the inputs"}
        </button>
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  wrap,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex gap-4">
      <dt className="w-24 shrink-0 text-nocturne-neutral-500">{label}</dt>
      <dd
        className={`${mono ? "font-mono tabular-nums" : ""} ${wrap ? "break-all" : ""} text-nocturne-neutral-300`}
      >
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function Seats({
  seats,
  humans,
  bots,
  drawn,
}: {
  seats: readonly LobbySeatView[];
  humans: number;
  bots: number;
  drawn: boolean;
}) {
  return (
    <section className="rounded-[14px] border border-nocturne-neutral-800 bg-nocturne-surface p-7">
      <h2 className="text-[19px] font-medium tracking-[-0.018em]">Who is here</h2>
      <p className="mt-1 text-[12px] text-nocturne-neutral-500">
        {seats.length} teams · {humans} {humans === 1 ? "manager" : "managers"}
        {bots > 0 && ` · ${bots} bot${bots === 1 ? "" : "s"}`}
      </p>

      <ul className="mt-5 divide-y divide-nocturne-neutral-800 border-t border-nocturne-neutral-800">
        {seats.map((seat) => (
          <li
            key={seat.teamId}
            className="flex items-center justify-between py-[10px] text-[13.5px]"
          >
            <span>
              {seat.name}
              {seat.isYou && (
                <span className="ml-2 text-[11px] text-nocturne-neutral-500">you</span>
              )}
              {seat.isCommissioner && (
                <span className="ml-2 text-[11px] text-nocturne-neutral-500">commissioner</span>
              )}
            </span>
            <span className="text-[11px] text-nocturne-neutral-500">
              {seat.isBot ? "Bot" : drawn ? `Pick ${seat.position}` : "Joined"}
            </span>
          </li>
        ))}
      </ul>

      {/*
        The design shows each seat as present or away. Nothing in this product
        tracks presence — there is no heartbeat and no socket — so rendering it
        would be an invention on the one screen whose argument is that nothing
        here is invented. What the copy can say truthfully is that being away
        costs nobody a pick, which is the reassurance the presence list existed
        to deliver.
      */}
      <p className="mt-5 text-[13px] leading-relaxed text-nocturne-neutral-400">
        Nobody needs to be watching. The clock is hard and expiry always results in a pick — the
        highest available player on your queue, or the best available at your most-needed
        position if the queue is empty.
      </p>
    </section>
  );
}

function Facts(props: DraftLobbyProps) {
  return (
    <section className="rounded-[14px] border border-nocturne-neutral-800 bg-nocturne-surface p-6">
      <p className="text-[10.5px] uppercase tracking-[0.14em] text-nocturne-neutral-500">
        Frozen rule set
      </p>
      <dl className="mt-4 space-y-3 text-[13px]">
        <Row
          label="Draft"
          value={`Snake · ${props.seats.length} teams · ${props.rounds} rounds`}
        />
        <Row label="Pick clock" value={`${props.pickSeconds}s`} />
        <Row label="Auto-pick" value="On, and unavoidable" />
        <Row label="Scheduled" value={stamp(props.scheduledAt)} />
      </dl>
    </section>
  );
}
