"use client";

import { useEffect } from "react";
import useSWR from "swr";
import { PlayerAvatar } from "./PlayerAvatar";
import {
  ageOn,
  heightText,
  injuryBadge,
  injuryTone,
  points,
  positionColour,
  positionGroup,
} from "@/lib/player";

/**
 * Everything known about one player, over the screen that asked.
 *
 * Opened by clicking a name anywhere — the draft board, a roster row, the player
 * market. One component for all three, because a player who reads differently
 * depending on which screen you came from is a player somebody will mis-draft.
 *
 * **Every number here is scored with this league's own rules**, computed by the
 * route from raw stat lines. Nothing on this card is stored as points, so it
 * cannot drift from the scoreboard that settles the same week.
 */

interface CardWeek {
  week: number;
  opponent: string | null;
  gameStatus: string | null;
  milliPoints: number;
}

interface CardResponse {
  player: {
    id: string;
    name: string;
    positions: string[];
    teamRef: string | null;
    imageUrl: string | null;
    byeWeek: number | null;
    bio: {
      jerseyNumber: string | null;
      heightInches: number | null;
      weightPounds: number | null;
      birthDate: string | null;
      college: string | null;
      draft: { year: number; round: number; pick: number } | null;
    };
    injury: {
      designation: string;
      description: string | null;
      returnDate: string | null;
    } | null;
  };
  weeks: CardWeek[];
  ownedBy: { teamId: string; teamName: string } | null;
  myTeamId: string | null;
}

const fetcher = async (url: string): Promise<CardResponse> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<CardResponse>;
};

export function PlayerCard({
  leagueId,
  playerId,
  onClose,
  /** Rendered under the name while the fetch is in flight. */
  fallbackName,
  fallbackPositions = [],
  /** An action bar the opening screen supplies — Draft, Queue, Add, Drop. */
  actions,
}: {
  leagueId: string;
  playerId: string;
  onClose: () => void;
  fallbackName?: string;
  fallbackPositions?: readonly string[];
  actions?: React.ReactNode;
}) {
  const { data, error } = useSWR<CardResponse>(
    `/api/leagues/${leagueId}/players/${playerId}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  // Escape closes it. A modal that can only be dismissed by finding the ✕ is
  // the one people complain about, and during a draft the clock is running.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const player = data?.player;
  const name = player?.name ?? fallbackName ?? "…";
  const positions = player?.positions ?? fallbackPositions;
  const group = positionGroup(positions);

  const played = (data?.weeks ?? []).filter(
    (week) => week.milliPoints !== 0 || week.gameStatus,
  );
  const total = played.reduce((sum, week) => sum + week.milliPoints, 0);
  const average = played.length > 0 ? Math.round(total / played.length) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      // A click on the backdrop closes; a click inside must not bubble out to
      // it, or selecting text on the card would dismiss the card.
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-nocturne-neutral-800 bg-nocturne-bg shadow-2xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={name}
      >
        <header className="flex items-start gap-4 border-b border-nocturne-neutral-900 p-5">
          <PlayerAvatar
            name={name}
            positions={positions}
            imageUrl={player?.imageUrl ?? null}
            size={72}
          />

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-medium">{name}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-nocturne-neutral-500">
              <span
                className={`rounded px-1.5 py-0.5 font-semibold ring-1 ${positionColour(group)}`}
              >
                {group}
              </span>
              {player?.teamRef && <span>{player.teamRef}</span>}
              {player?.bio.jerseyNumber && <span>#{player.bio.jerseyNumber}</span>}
              {player?.byeWeek !== null && player?.byeWeek !== undefined && (
                <span>bye {player.byeWeek}</span>
              )}
              {player?.injury && (
                <span className={injuryTone(player.injury.designation)}>
                  {injuryBadge(player.injury.designation)}
                </span>
              )}
            </p>

            <p className="mt-1 text-xs text-nocturne-neutral-600">
              {data
                ? data.ownedBy
                  ? data.ownedBy.teamId === data.myTeamId
                    ? "On your roster"
                    : `Rostered by ${data.ownedBy.teamName}`
                  : "Free agent"
                : " "}
            </p>
          </div>

          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-nocturne-neutral-500 hover:text-nocturne-text"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {error && <p className="p-5 text-sm text-red-400">{error.message}</p>}

        {player?.injury?.description && (
          <p className="border-b border-nocturne-neutral-900 px-5 py-3 text-xs text-nocturne-neutral-400">
            <span className={`font-medium ${injuryTone(player.injury.designation)}`}>
              {player.injury.designation}
            </span>{" "}
            — {player.injury.description}
            {player.injury.returnDate && ` · expected back ${player.injury.returnDate}`}
          </p>
        )}

        {actions && (
          <div className="flex flex-wrap gap-2 border-b border-nocturne-neutral-900 px-5 py-3">
            {actions}
          </div>
        )}

        <section className="grid grid-cols-2 gap-x-6 gap-y-3 p-5 text-sm sm:grid-cols-4">
          <Fact label="Season" value={points(total || null)} />
          <Fact label="Per game" value={points(average)} />
          <Fact label="Games" value={played.length > 0 ? String(played.length) : "—"} />
          <Fact
            label="Age"
            value={(() => {
              // Computed against the reader's own day, from a stored birth date.
              // An age column would be wrong the day after it was written.
              const age = ageOn(player?.bio.birthDate ?? null, new Date());
              return age === null ? "—" : String(age);
            })()}
          />
          <Fact label="Height" value={heightText(player?.bio.heightInches ?? null) ?? "—"} />
          <Fact
            label="Weight"
            value={player?.bio.weightPounds ? `${player.bio.weightPounds} lb` : "—"}
          />
          <Fact label="College" value={player?.bio.college ?? "—"} />
          <Fact
            label="Drafted"
            value={
              player?.bio.draft
                ? `${player.bio.draft.year} · R${player.bio.draft.round} P${player.bio.draft.pick}`
                : player
                  ? "Undrafted"
                  : "—"
            }
          />
        </section>

        <section className="border-t border-nocturne-neutral-900 p-5">
          <h3 className="text-xs font-medium tracking-wide text-nocturne-neutral-500 uppercase">
            Game log
            <span className="ml-2 font-normal normal-case">
              scored with this league&rsquo;s rules
            </span>
          </h3>

          {!data ? (
            <p className="pt-2 text-xs text-nocturne-neutral-600">Loading…</p>
          ) : data.weeks.length === 0 ? (
            <p className="pt-2 text-xs text-nocturne-neutral-600">
              No games played yet this season.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-nocturne-neutral-900 text-sm">
              {data.weeks.map((week) => (
                <li key={week.week} className="flex items-center gap-3 py-1.5">
                  <span className="w-14 text-xs text-nocturne-neutral-600">
                    Week {week.week}
                  </span>
                  <span className="flex-1 text-xs text-nocturne-neutral-500">
                    {week.opponent ?? "—"}
                    {week.gameStatus && week.gameStatus !== "FINAL" && (
                      <span className="ml-2 text-nocturne-accent-400">
                        {week.gameStatus === "IN_PROGRESS"
                          ? "live"
                          : week.gameStatus.toLowerCase()}
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">{points(week.milliPoints)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] tracking-wide text-nocturne-neutral-600 uppercase">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}
