"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";

/**
 * Adds, drops and waiver claims.
 *
 * The same button says "Add" or "Claim" depending on where the player stands,
 * because those are genuinely different things: an add is immediate and first
 * come first served, a claim waits for the run that player clears at and is
 * decided by priority.
 * Showing one control that quietly does either would hide the only distinction
 * that matters here.
 *
 * The server decides which happens regardless of what this component thinks.
 */

interface Available {
  playerId: string;
  name: string;
  positions: string[];
  availability: "ON_WAIVERS" | "FREE_AGENT";
  clearsAt: string | null;
}

interface Rostered {
  playerId: string;
  name: string;
  position: string;
}

interface Claim {
  claimId: string;
  addPlayerId: string;
  dropPlayerId: string | null;
}

interface MarketResponse {
  available: Available[];
  roster: Rostered[];
  claims: Claim[];
}

const fetcher = async (url: string): Promise<MarketResponse> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<MarketResponse>;
};

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"] as const;

function clearsIn(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.max(0, (new Date(iso).getTime() - Date.now()) / 1000);
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `clears in ${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `clears in ${hours}h`;
  return "clears shortly";
}

export function PlayerMarket({ leagueId }: { leagueId: string }) {
  const { data, error, mutate } = useSWR<MarketResponse>(
    `/api/leagues/${leagueId}/players`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const [position, setPosition] = useState<(typeof POSITIONS)[number]>("ALL");
  const [search, setSearch] = useState("");
  const [dropWith, setDropWith] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.available ?? [])
      .filter((p) => position === "ALL" || p.positions.includes(position))
      .filter((p) => term === "" || p.name.toLowerCase().includes(term))
      .slice(0, 100);
  }, [data, position, search]);

  const claimedIds = useMemo(
    () => new Set((data?.claims ?? []).map((claim) => claim.addPlayerId)),
    [data],
  );

  if (error) return <p className="text-sm text-red-400">{error.message}</p>;
  if (!data) return <p className="text-sm text-white/40">Loading players…</p>;

  async function act(body: unknown): Promise<void> {
    setBusy(true);
    setNote(null);
    setFailure(null);

    try {
      const response = await fetch(`/api/leagues/${leagueId}/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        error?: string;
        added?: boolean;
        claimed?: boolean;
        dropped?: boolean;
        destination?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "That did not work");

      if (payload.claimed) {
        // Not "the next waiver run" — a player who has not served his waiver
        // period is not awarded at the next run, he waits for the run he clears
        // at. The screen already shows that time beside his name.
        setNote("Claim submitted. It resolves by priority, at the run he clears at.");
      } else if (payload.added) {
        setNote("Added.");
      } else if (payload.dropped) {
        setNote(
          payload.destination === "WAIVERS"
            ? "Dropped — he goes to waivers, not straight back to the pool."
            : "Dropped — he was held under a day, so he is a free agent immediately.",
        );
      }

      setDropWith("");
      await mutate();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {note && (
        <p className="rounded border border-[--color-turf]/30 bg-[--color-turf]/5 px-4 py-3 text-sm">
          {note}
        </p>
      )}
      {failure && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {failure}
        </p>
      )}

      {data.claims.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-white/70">
            Your pending claims
            <span className="ml-2 text-xs font-normal text-white/30">
              blind — nobody sees them until they resolve
            </span>
          </h2>
          <ul className="space-y-1 text-xs">
            {data.claims.map((claim) => (
              <li key={claim.claimId} className="flex items-center gap-2">
                <span className="flex-1 truncate">
                  {data.available.find((p) => p.playerId === claim.addPlayerId)?.name ??
                    claim.addPlayerId}
                </span>
                <button
                  onClick={() => void act({ action: "CANCEL_CLAIM", claimId: claim.claimId })}
                  disabled={busy}
                  className="text-white/40 hover:text-white disabled:opacity-30"
                >
                  withdraw
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {POSITIONS.map((slot) => (
            <button
              key={slot}
              onClick={() => setPosition(slot)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                position === slot
                  ? "bg-[--color-turf] text-black"
                  : "border border-white/15 text-white/70 hover:text-white"
              }`}
            >
              {slot}
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="ml-auto w-40 rounded border border-white/15 bg-transparent px-3 py-1 text-sm"
          />
        </div>

        <label className="block text-xs text-white/50">
          Drop to make room (optional)
          <select
            value={dropWith}
            onChange={(e) => setDropWith(e.target.value)}
            className="ml-2 rounded border border-white/15 bg-transparent px-2 py-1 text-sm"
          >
            <option value="">— nobody —</option>
            {data.roster.map((player) => (
              <option key={player.playerId} value={player.playerId}>
                {player.position} {player.name}
              </option>
            ))}
          </select>
        </label>

        <ul className="divide-y divide-white/5 rounded border border-white/10">
          {shown.map((player) => (
            <li key={player.playerId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-12 text-xs text-white/40">{player.positions.join("/")}</span>
              <span className="flex-1 truncate text-sm">{player.name}</span>

              {player.availability === "ON_WAIVERS" && (
                <span className="text-xs text-amber-400/70">{clearsIn(player.clearsAt)}</span>
              )}

              <button
                onClick={() =>
                  void act({
                    action: "ADD",
                    playerId: player.playerId,
                    dropPlayerId: dropWith || null,
                  })
                }
                disabled={busy || claimedIds.has(player.playerId)}
                className="rounded bg-[--color-turf] px-3 py-1 text-xs font-medium text-black disabled:opacity-30"
              >
                {claimedIds.has(player.playerId)
                  ? "Claimed"
                  : player.availability === "ON_WAIVERS"
                    ? "Claim"
                    : "Add"}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-white/70">Your roster</h2>
        <ul className="divide-y divide-white/5 rounded border border-white/10">
          {data.roster.map((player) => (
            <li key={player.playerId} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="w-12 text-xs text-white/40">{player.position}</span>
              <span className="flex-1 truncate">{player.name}</span>
              <button
                onClick={() => void act({ action: "DROP", playerId: player.playerId })}
                disabled={busy}
                className="rounded border border-white/15 px-2 py-1 text-xs text-white/60 hover:text-white disabled:opacity-30"
              >
                Drop
              </button>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-white/30">
        A player you drop goes to waivers unless you held him less than a day, in which case he
        is a free agent immediately. That rule stops anyone adding a player, cutting him, and
        re-adding him to skip the queue.
      </p>
    </div>
  );
}
