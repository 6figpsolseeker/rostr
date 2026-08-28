"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";

/**
 * Proposing, answering and vetoing trades.
 *
 * Three things on this screen are deliberate rather than decorative:
 *
 *   * **The veto count is always visible**, on every accepted trade, to
 *     everybody. A veto that arrived without warning would feel like a
 *     commissioner reversing a result, which is the thing this project exists
 *     to remove. Showing "1 of 2" means the trade's fate is public while it is
 *     still being decided.
 *   * **A locked player is shown, not hidden.** He is committed to an accepted
 *     trade and cannot be offered again; removing him from the list would read
 *     as the roster being wrong.
 *   * **There is no commissioner control here at all** — not disabled, absent.
 *
 * The server decides all of it regardless of what this component renders.
 */

interface TeamPlayer {
  playerId: string;
  name: string;
  position: string;
  locked: boolean;
}

interface TradeTeam {
  teamId: string;
  name: string;
  isBot: boolean;
  players: TeamPlayer[];
}

interface Trade {
  tradeId: string;
  proposerTeamId: string;
  receiverTeamId: string;
  state: "PROPOSED" | "ACCEPTED" | "VETOED" | "EXECUTED" | "WITHDRAWN" | "EXPIRED";
  proposedAt: string;
  vetoDeadline: string | null;
  proposerGives: string[];
  receiverGives: string[];
  vetoes: number;
  vetoesRequired: number;
}

interface TradesResponse {
  myTeamId: string;
  enabled: boolean;
  deadlineWeek: number;
  vetoWindowHours: number;
  /**
   * Whether a proposal made now would already land past the deadline.
   *
   * Decided by the server, not by comparing a week here. There is no week to
   * compare once the season's games are exhausted, and the field this replaced
   * reported that case as week zero — which rendered as "trading is open", in
   * January, permanently.
   */
  tradingClosed: boolean;
  /**
   * Whether the league is playing at all, and why not when it is not.
   *
   * Separate from `tradingClosed`, which is the deadline. Both can shut trading
   * and they say different things — "the deadline has passed" is wrong and
   * confusing in August, when the real answer is that the draft is still on.
   */
  trading: { open: boolean; notice: string | null };
  teams: TradeTeam[];
  trades: Trade[];
}

const fetcher = async (url: string): Promise<TradesResponse> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<TradesResponse>;
};

function closesIn(iso: string | null): string {
  if (!iso) return "";
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  if (seconds <= 0) return "window closed — resolving";
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)}d left to object`;
  if (hours >= 1) return `${hours}h left to object`;
  return "closing shortly";
}

export function TradeBlock({ leagueId }: { leagueId: string }) {
  const { data, error, mutate } = useSWR<TradesResponse>(
    `/api/leagues/${leagueId}/trades`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const [withTeam, setWithTeam] = useState("");
  const [iGive, setIGive] = useState<Set<string>>(new Set());
  const [theyGive, setTheyGive] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of data?.teams ?? []) {
      for (const player of team.players) map.set(player.playerId, player.name);
    }
    return map;
  }, [data]);

  const teamNames = useMemo(
    () => new Map((data?.teams ?? []).map((team) => [team.teamId, team.name])),
    [data],
  );

  if (error) return <p className="text-sm text-red-400">{error.message}</p>;
  if (!data) return <p className="text-sm text-nocturne-neutral-600">Loading trades…</p>;

  const mine = data.teams.find((team) => team.teamId === data.myTeamId);
  const partner = data.teams.find((team) => team.teamId === withTeam);
  const pastDeadline = data.tradingClosed;

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  async function act(body: unknown, success: string): Promise<void> {
    setBusy(true);
    setNote(null);
    setFailure(null);

    try {
      const response = await fetch(`/api/leagues/${leagueId}/trades`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "That did not work");

      setNote(success);
      setIGive(new Set());
      setTheyGive(new Set());
      await mutate();
    } catch (e) {
      // Refresh on the way out as well as on success. Every refusal here means
      // the card is showing something that is no longer true — a settled trade
      // with a live Veto button, or a window that has shut — so leaving it up
      // invites a second press that gets a different message for the same fact.
      void mutate();
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const open = data.trades.filter(
    (trade) => trade.state === "PROPOSED" || trade.state === "ACCEPTED",
  );
  const settled = data.trades.filter(
    (trade) => trade.state !== "PROPOSED" && trade.state !== "ACCEPTED",
  );

  return (
    <div className="space-y-8">
      {note && (
        <p className="rounded border border-nocturne-accent/30 px-4 py-3 text-sm">{note}</p>
      )}
      {failure && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {failure}
        </p>
      )}

      {!data.enabled && (
        <p className="rounded border border-nocturne-neutral-900 px-4 py-3 text-sm text-nocturne-neutral-400">
          This league does not allow trades. That was frozen when it was created and cannot be
          changed.
        </p>
      )}

      {data.trading.notice !== null && (
        // Above the deadline banner, because it is the more basic fact: a league
        // that is not playing has not reached its deadline, and saying both
        // would be saying one wrong thing.
        <p className="rounded border border-nocturne-neutral-800 bg-nocturne-neutral-950 px-4 py-3 text-sm text-nocturne-neutral-400">
          {data.trading.notice}
        </p>
      )}

      {data.enabled && data.trading.open && pastDeadline && (
        <p className="rounded border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200/80">
          The trade deadline is the end of week {data.deadlineWeek}, and an accepted trade waits{" "}
          {data.vetoWindowHours} hours before it executes — so anything proposed now would land
          after it. Nothing new can be proposed.
        </p>
      )}

      {/* --------------------------------------------------------------- */}
      {/* Building an offer                                                */}
      {/* --------------------------------------------------------------- */}
      {data.enabled && data.trading.open && !pastDeadline && mine && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-nocturne-neutral-400">Propose a trade</h2>

          <label className="block text-xs text-nocturne-neutral-500">
            With
            <select
              value={withTeam}
              onChange={(e) => {
                setWithTeam(e.target.value);
                setTheyGive(new Set());
              }}
              className="ml-2 rounded border border-nocturne-neutral-800 bg-transparent px-2 py-1 text-sm"
            >
              <option value="">— choose a team —</option>
              {data.teams
                .filter((team) => team.teamId !== data.myTeamId && !team.isBot)
                .map((team) => (
                  <option key={team.teamId} value={team.teamId}>
                    {team.name}
                  </option>
                ))}
            </select>
          </label>

          {partner && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Roster
                title="You give"
                players={mine.players}
                selected={iGive}
                onToggle={(id) => setIGive(toggle(iGive, id))}
              />
              <Roster
                title={`${partner.name} gives`}
                players={partner.players}
                selected={theyGive}
                onToggle={(id) => setTheyGive(toggle(theyGive, id))}
              />
            </div>
          )}

          {partner && (
            <button
              onClick={() =>
                void act(
                  {
                    action: "PROPOSE",
                    receiverTeamId: partner.teamId,
                    proposerGives: [...iGive],
                    receiverGives: [...theyGive],
                  },
                  "Offer sent. It is theirs to accept or decline.",
                )
              }
              disabled={busy || iGive.size === 0 || theyGive.size === 0}
              className="rounded rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-30"
            >
              Send offer
            </button>
          )}

          {partner && (iGive.size === 0 || theyGive.size === 0) && (
            <p className="text-xs text-nocturne-neutral-600">
              Both sides have to give somebody up — a one-way transfer is not a trade.
            </p>
          )}
        </section>
      )}

      {/* --------------------------------------------------------------- */}
      {/* Live trades                                                      */}
      {/* --------------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-nocturne-neutral-400">Open trades</h2>
        {open.length === 0 && (
          <p className="text-sm text-nocturne-neutral-600">Nothing on the table.</p>
        )}

        <ul className="space-y-3">
          {open.map((trade) => {
            const involved =
              trade.proposerTeamId === data.myTeamId || trade.receiverTeamId === data.myTeamId;

            return (
              <li
                key={trade.tradeId}
                className="space-y-3 rounded border border-nocturne-neutral-900 p-4"
              >
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <Side
                    label={teamNames.get(trade.proposerTeamId) ?? "?"}
                    players={trade.proposerGives.map((id) => names.get(id) ?? id)}
                  />
                  <Side
                    label={teamNames.get(trade.receiverTeamId) ?? "?"}
                    players={trade.receiverGives.map((id) => names.get(id) ?? id)}
                  />
                </div>

                {trade.state === "ACCEPTED" && (
                  <p className="text-xs text-nocturne-neutral-500">
                    Accepted — {closesIn(trade.vetoDeadline)}.{" "}
                    <span className={trade.vetoes > 0 ? "text-amber-300/80" : ""}>
                      {trade.vetoes} of {trade.vetoesRequired} vetoes
                    </span>{" "}
                    needed to block it.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  {trade.state === "PROPOSED" && trade.receiverTeamId === data.myTeamId && (
                    <>
                      {/*
                        Accept goes when the league is not playing; Decline stays.
                        That asymmetry is the point: a stale offer left from a
                        draft has to be dismissable, or it sits here with no
                        legal action available to anybody. The notice above says
                        why Accept is missing.
                      */}
                      {data.trading.open && (
                        <button
                          onClick={() =>
                            void act(
                              { action: "ACCEPT", tradeId: trade.tradeId },
                              `Accepted. It executes in ${data.vetoWindowHours} hours unless the league blocks it.`,
                            )
                          }
                          disabled={busy}
                          className="rounded border border-nocturne-accent px-3 py-1 text-xs font-medium text-black disabled:opacity-30"
                        >
                          Accept
                        </button>
                      )}
                      <button
                        onClick={() =>
                          void act({ action: "DECLINE", tradeId: trade.tradeId }, "Declined.")
                        }
                        disabled={busy}
                        className="rounded border border-nocturne-neutral-800 px-3 py-1 text-xs disabled:opacity-30"
                      >
                        Decline
                      </button>
                    </>
                  )}

                  {trade.state === "PROPOSED" && trade.proposerTeamId === data.myTeamId && (
                    <button
                      onClick={() =>
                        void act({ action: "WITHDRAW", tradeId: trade.tradeId }, "Withdrawn.")
                      }
                      disabled={busy}
                      className="rounded border border-nocturne-neutral-800 px-3 py-1 text-xs disabled:opacity-30"
                    >
                      Withdraw
                    </button>
                  )}

                  {trade.state === "ACCEPTED" && !involved && (
                    <button
                      onClick={() =>
                        void act({ action: "VETO", tradeId: trade.tradeId }, "Vote recorded.")
                      }
                      disabled={busy}
                      className="rounded border border-amber-500/40 px-3 py-1 text-xs text-amber-200 disabled:opacity-30"
                    >
                      Veto
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {settled.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-nocturne-neutral-400">Settled</h2>
          <ul className="space-y-1 text-xs text-nocturne-neutral-500">
            {settled.map((trade) => (
              <li key={trade.tradeId} className="flex gap-2">
                <span className="w-20 shrink-0 uppercase tracking-wide">
                  {trade.state.toLowerCase()}
                </span>
                <span className="flex-1">
                  {teamNames.get(trade.proposerTeamId)} ⇄ {teamNames.get(trade.receiverTeamId)}
                  {" — "}
                  {trade.proposerGives.map((id) => names.get(id) ?? id).join(", ")} for{" "}
                  {trade.receiverGives.map((id) => names.get(id) ?? id).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Roster({
  title,
  players,
  selected,
  onToggle,
}: {
  title: string;
  players: TeamPlayer[];
  selected: Set<string>;
  onToggle: (playerId: string) => void;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-nocturne-neutral-500">{title}</h3>
      <ul className="divide-y divide-nocturne-neutral-900 rounded border border-nocturne-neutral-900">
        {players.map((player) => (
          <li key={player.playerId}>
            <label
              className={`flex items-center gap-2 px-3 py-2 text-sm ${
                player.locked ? "opacity-40" : "cursor-pointer hover:bg-nocturne-surface"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(player.playerId)}
                onChange={() => onToggle(player.playerId)}
                disabled={player.locked}
              />
              <span className="w-9 text-xs text-nocturne-neutral-600">{player.position}</span>
              <span className="flex-1 truncate">{player.name}</span>
              {player.locked && (
                <span className="text-xs text-nocturne-neutral-600">in a trade</span>
              )}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Side({ label, players }: { label: string; players: string[] }) {
  return (
    <div>
      <p className="text-xs text-nocturne-neutral-600">{label} gives</p>
      <p>{players.join(", ") || "—"}</p>
    </div>
  );
}
