"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerCard } from "./PlayerCard";
import { injuryBadge, injuryTone, positionColour, positionGroup } from "@/lib/player";

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
  /** Display only. Null on a pool synced before migration `0032`. */
  imageUrl: string | null;
  teamRef: string | null;
  injuryDesignation: string | null;
}

interface Rostered {
  playerId: string;
  name: string;
  position: string;
  imageUrl: string | null;
  teamRef: string | null;
  injuryDesignation: string | null;
  onIr: boolean;
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
  /**
   * Whether this league is transacting, and why not when it is not.
   *
   * The sentence is composed by the server from the same function that refuses
   * the write, so the two cannot drift. Rendering a button the server will
   * refuse is the failure this exists to prevent — it turns a rule into a wall.
   */
  market: { open: boolean; notice: string | null };
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
  /** The player whose card is open. A face or a name anywhere here opens one. */
  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);
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
  if (!data) return <p className="text-sm text-nocturne-neutral-600">Loading players…</p>;

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
        <p className="rounded border border-nocturne-accent/30 px-4 py-3 text-sm">{note}</p>
      )}
      {failure && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {failure}
        </p>
      )}

      {data.market.notice !== null && (
        // Said once, at the top, rather than on every row. The buttons below are
        // gone rather than disabled: a disabled button invites a manager to work
        // out why, and the sentence has already told them.
        <p className="rounded border border-nocturne-neutral-800 bg-nocturne-neutral-950 px-3 py-2 text-xs text-nocturne-neutral-400">
          {data.market.notice}
        </p>
      )}

      {data.claims.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-nocturne-neutral-400">
            Your pending claims
            <span className="ml-2 text-xs font-normal text-nocturne-neutral-600">
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
                  className="text-nocturne-neutral-600 hover:text-nocturne-text disabled:opacity-30"
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
                  ? "border border-nocturne-accent text-nocturne-accent-200"
                  : "border border-nocturne-neutral-800 text-nocturne-neutral-400 hover:text-nocturne-text"
              }`}
            >
              {slot}
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="ml-auto w-40 rounded border border-nocturne-neutral-800 bg-transparent px-3 py-1 text-sm"
          />
        </div>

        <label className="block text-xs text-nocturne-neutral-500">
          Drop to make room (optional)
          <select
            value={dropWith}
            onChange={(e) => setDropWith(e.target.value)}
            className="ml-2 rounded border border-nocturne-neutral-800 bg-transparent px-2 py-1 text-sm"
          >
            <option value="">— nobody —</option>
            {data.roster.map((player) => (
              <option key={player.playerId} value={player.playerId}>
                {player.position} {player.name}
                {player.onIr ? " (IR — dropping him frees no space)" : ""}
              </option>
            ))}
          </select>
        </label>

        <ul className="divide-y divide-nocturne-neutral-900 rounded border border-nocturne-neutral-900">
          {shown.map((player) => (
            <li key={player.playerId} className="flex items-center gap-3 px-4 py-2.5">
              <button
                onClick={() => setOpenPlayerId(player.playerId)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                title={`${player.name} — open card`}
              >
                <PlayerAvatar
                  name={player.name}
                  positions={player.positions}
                  imageUrl={player.imageUrl}
                  size={32}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{player.name}</span>
                    {injuryBadge(player.injuryDesignation) && (
                      <span
                        className={`text-[10px] font-semibold ${injuryTone(player.injuryDesignation)}`}
                      >
                        {injuryBadge(player.injuryDesignation)}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-nocturne-neutral-600">
                    <span
                      className={`rounded px-1 py-px font-medium ring-1 ${positionColour(positionGroup(player.positions))}`}
                    >
                      {positionGroup(player.positions)}
                    </span>
                    {player.teamRef ?? "FA"}
                  </span>
                </span>
              </button>

              {player.availability === "ON_WAIVERS" && (
                <span className="text-xs text-amber-400/70">{clearsIn(player.clearsAt)}</span>
              )}

              {data.market.open && (
                <button
                  onClick={() =>
                    void act({
                      action: "ADD",
                      playerId: player.playerId,
                      dropPlayerId: dropWith || null,
                    })
                  }
                  disabled={busy || claimedIds.has(player.playerId)}
                  className="rounded border border-nocturne-accent px-3 py-1 text-xs font-medium text-black disabled:opacity-30"
                >
                  {claimedIds.has(player.playerId)
                    ? "Claimed"
                    : player.availability === "ON_WAIVERS"
                      ? "Claim"
                      : "Add"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-nocturne-neutral-400">Your roster</h2>
        <ul className="divide-y divide-nocturne-neutral-900 rounded border border-nocturne-neutral-900">
          {data.roster.map((player) => (
            <li key={player.playerId} className="flex items-center gap-3 px-4 py-2 text-sm">
              <button
                onClick={() => setOpenPlayerId(player.playerId)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <PlayerAvatar
                  name={player.name}
                  positions={[player.position]}
                  imageUrl={player.imageUrl}
                  size={32}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{player.name}</span>
                    {injuryBadge(player.injuryDesignation) && (
                      <span
                        className={`text-[10px] font-semibold ${injuryTone(player.injuryDesignation)}`}
                      >
                        {injuryBadge(player.injuryDesignation)}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-nocturne-neutral-600">
                    <span
                      className={`rounded px-1 py-px font-medium ring-1 ${positionColour(player.position)}`}
                    >
                      {player.position}
                    </span>
                    {player.teamRef ?? "FA"}
                  </span>
                </span>
              </button>
              {data.market.open && (
                <button
                  onClick={() => void act({ action: "DROP", playerId: player.playerId })}
                  disabled={busy}
                  className="rounded border border-nocturne-neutral-800 px-2 py-1 text-xs text-nocturne-neutral-400 hover:text-nocturne-text disabled:opacity-30"
                >
                  Drop
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {openPlayerId && (
        <PlayerCard
          leagueId={leagueId}
          playerId={openPlayerId}
          onClose={() => setOpenPlayerId(null)}
        />
      )}

      <p className="text-xs text-nocturne-neutral-600">
        A player you drop goes to waivers unless you held him less than a day, in which case he
        is a free agent immediately. That rule stops anyone adding a player, cutting him, and
        re-adding him to skip the queue.
      </p>
    </div>
  );
}
