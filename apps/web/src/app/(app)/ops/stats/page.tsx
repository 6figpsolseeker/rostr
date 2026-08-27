import { notFound } from "next/navigation";
import { listCronRuns, unresolvedStatsProblems } from "@rostr/db";
import { NFL } from "@rostr/core";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import {
  buildOpsView,
  buildRunBanner,
  ingestSentence,
  toneOf,
  type ProblemRow,
  type RunBanner,
} from "@/lib/ops";

/**
 * Games whose stats contradicted themselves.
 *
 * ## Why this screen exists
 *
 * The translator has fourteen places where it notices the provider disagreeing
 * with itself — a field-goal count that does not match the plays parsed from
 * it, a defence missing from a box score, a defensive touchdown total that
 * cannot be true. Every one of those writes `games.stats_error`, and until this
 * page **nothing rendered that column**. The only reader was the stats cron,
 * which folded the count into a heartbeat string, and the only way to see
 * *which* game or *what* was wrong was to run a CLI on a laptop.
 *
 * So a detection built to stop a silent scoring defect was itself silent. This
 * is the other half of it.
 *
 * ## Read-only, deliberately, for now
 *
 * Nothing here corrects anything. The machinery exists — `stat_lines` is
 * revision-based and a new revision supersedes — but writing one is a scoring
 * change, and the first slice of a screen that has never been looked at should
 * not also be the thing that edits scores. Seeing the problem is the part that
 * was missing.
 *
 * ## 404, never 403
 *
 * The same rule the league pages follow: a 403 confirms the page exists, and
 * "there is an operator console at this URL" is precisely the fact worth not
 * publishing. `isOperator` fails closed when `OPERATOR_EMAILS` is unset, in
 * every environment including development — see the note there for why this one
 * does not relax the way `cronForbidden` does.
 */

export const metadata = {
  title: "Stats problems — rostr ops",
};

export const dynamic = "force-dynamic";

/**
 * What we hold for this game. The tone lives here and nowhere else.
 *
 * **Colour keys on the ingest state, never on the window state**, and that was
 * the presentation half of issue #233: a game whose every read had failed drew
 * in the lowest-contrast tone on the page, because its provider had not called
 * it final yet. The most severe row wore the calmest chip.
 */
function IngestChip({ row }: { row: ProblemRow }) {
  const label =
    row.ingest === "NO_STATS"
      ? "No box score"
      : row.ingest === "STALE"
        ? "Stats are stale"
        : "Discrepancy";

  const tone = toneOf(row.ingest);
  const cls =
    tone === "critical"
      ? "border-red-500/50 text-red-300"
      : tone === "warning"
        ? "border-amber-500/40 text-amber-300"
        : "border-nocturne-neutral-800 text-nocturne-neutral-500";

  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[11px] tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

/**
 * Whether the week can still be corrected. Deliberately neutral in every state.
 *
 * Two chips rather than one, because the axes are independent: what we hold and
 * whether it can still be changed. A single chip has to pick one and hide the
 * other, and it used to hide the one that mattered.
 */
function WindowChip({ row }: { row: ProblemRow }) {
  const label =
    row.status === "WEEK_IN_PLAY"
      ? "Week still in play"
      : row.status === "OPEN"
        ? `${row.hoursSinceWeekEnd}h of ${row.windowHours}h`
        : `Window closed (${row.windowHours}h)`;

  return (
    <span className="shrink-0 rounded-full border border-nocturne-neutral-800 px-2.5 py-1 font-mono text-[11px] tracking-wide text-nocturne-neutral-500">
      {label}
    </span>
  );
}

/**
 * The stats job's own heartbeat, above the list.
 *
 * An empty list beside a job that is not running is a false all-clear — the same
 * defect as the prose this page used to carry. It is also the only way a
 * run-level fault reaches this screen: the pool check, a database fault, a
 * provider auth failure and #256's own "a slate was under way and nothing was
 * selected" alarm all throw before any game is touched, so they write no
 * `stats_error` and produce no row here.
 */
function RunBannerView({ banner }: { banner: RunBanner }) {
  if (banner.state === "OK") return null;

  const cls =
    banner.state === "FAILING"
      ? "border-red-500/50 text-red-200"
      : "border-amber-500/40 text-amber-200";

  return (
    <div className={`mt-6 rounded-[4px] border p-4 text-[13.5px] leading-[1.6] ${cls}`}>
      <p className="font-mono text-[11px] tracking-[0.16em] uppercase opacity-70">
        {banner.state === "FAILING"
          ? "the stats job is failing"
          : banner.state === "NEVER_RAN"
            ? "the stats job has never run"
            : "the stats job is behind"}
      </p>
      <p className="mt-2 break-words">{banner.detail}</p>
    </div>
  );
}

function ProblemList({ rows }: { rows: readonly ProblemRow[] }) {
  return (
    <ul className="mt-4 space-y-3">
      {rows.map((row) => (
        <li key={row.gameRef} className="rounded-[4px] border border-nocturne-neutral-800 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[13px] text-nocturne-neutral-300">{row.gameRef}</p>
              <p className="mt-1 text-[12px] text-nocturne-neutral-500">
                {row.season} · week {row.week}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <IngestChip row={row} />
              <WindowChip row={row} />
            </div>
          </div>
          {/*
            What this state costs, then the provider's own words unedited.
            Summarising the second would put a competing description next to the
            one the translator wrote, and the translator's names the fields.

            The sentence is not optional: a row selected by the clock rather than
            by an error carries no provider text at all, and without this it
            would render as an empty card — which is how the state this page was
            fixed to surface would have stayed invisible.
          */}
          <p className="mt-3 border-t border-nocturne-neutral-800 pt-3 text-[13.5px] leading-[1.6] text-nocturne-neutral-300">
            {ingestSentence(row)}
          </p>
          {row.problem === null ? null : (
            <p className="mt-2 text-[13px] leading-[1.6] break-words text-nocturne-neutral-500">
              {row.problem}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export default async function OpsStatsPage() {
  const user = await currentUser();
  if (!isOperator(user?.email)) notFound();

  const now = new Date();
  const problems = await unresolvedStatsProblems(db(), NFL.key, 50);
  const view = buildOpsView(problems, now);
  const banner = buildRunBanner(
    (await listCronRuns(db())).find((entry) => entry.name === "stats"),
    now,
  );

  return (
    <main className="mx-auto max-w-[900px] px-6 py-14">
      <p className="font-mono text-[11px] tracking-[0.16em] text-nocturne-neutral-500 uppercase">
        rostr ops
      </p>
      <h1 className="mt-3 text-[32px] leading-[1.1] font-medium tracking-[-0.02em]">
        Stats problems
      </h1>
      {/*
        **The sentence that used to sit here is deleted, not reworded.**

        It read: "Games where the provider's own numbers disagreed with each
        other. The stat lines were still ingested — these are discrepancies, not
        failures — so every one of these games has been scored, possibly
        wrongly."

        Every clause of that is false for a game with no box score: nothing was
        ingested, it is a failure, and the game has not been scored — its players
        are all on zero. It was a page-level claim about a heterogeneous list,
        which is a category error no rewrite fixes, and it was rendered to the
        operator at the moment they were deciding whether to act.

        The claim now lives on the rows it is true of, via `ingestSentence`.
        Issue #233. Do not restore a blanket assertion here.
      */}
      <p className="mt-4 max-w-[62ch] text-[14.5px] leading-[1.62] text-nocturne-neutral-400">
        Games whose box scores are missing, stale, or flagged by the translator. What each row
        costs is on the row.
      </p>

      <p className="mt-6 font-mono text-[12px] text-nocturne-neutral-500">
        {view.total === 0
          ? "none outstanding"
          : [
              view.noStats.length > 0 ? `${view.noStats.length} with no box score` : null,
              view.stale.length > 0 ? `${view.stale.length} stale` : null,
              view.discrepancies.length > 0 ? `${view.discrepancies.length} flagged` : null,
              view.shown < view.total ? `showing ${view.shown} of ${view.total}` : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
      </p>

      <RunBannerView banner={banner} />

      {view.total === 0 ? (
        <p className="mt-8 rounded-[4px] border border-nocturne-neutral-800 p-5 text-[13.5px] leading-[1.6] text-nocturne-neutral-500">
          Nothing flagged. Worth knowing what that does and does not mean: it says no game has
          tripped one of the translator&rsquo;s checks, not that every score is right. A defect
          in a category nothing cross-checks looks exactly like this
          {banner.state === "OK"
            ? "."
            : " \u2014 and the banner above says the job producing these checks is not healthy, so this list is not evidence of anything right now."}
        </p>
      ) : null}

      {/*
        Grouped by **what we hold**, not by whether it can still be fixed.

        The old split was "Still correctable" / "Past the window", which answers
        one question for a list whose rows differ by an order of magnitude in
        what they cost: a game with no box score at all sat beside a field-goal
        count disagreeing with itself, in the same section, in the same tone.
        Recoverability survives as a chip on every row.
      */}
      {view.noStats.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-[15px] font-medium text-red-300">No box score</h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.6] text-nocturne-neutral-500">
            Nothing usable was written for these games, so every player in them scores zero in
            every league. Once a week finalises that is permanent. This is the set that holds{" "}
            <span className="font-mono">score-week</span> open.
          </p>
          <ProblemList rows={view.noStats} />
        </section>
      ) : null}

      {view.stale.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-[15px] font-medium text-amber-300">Stale</h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.6] text-nocturne-neutral-500">
            Stat lines exist from an earlier read and the most recent read failed. The
            scoreboard is showing numbers older than the game, live, to managers.
          </p>
          <ProblemList rows={view.stale} />
        </section>
      ) : null}

      {view.discrepancies.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-[15px] font-medium text-nocturne-neutral-400">
            Ingested, with a discrepancy
          </h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.6] text-nocturne-neutral-500">
            {/*
              The one true sentence from the deleted page-level claim, now sitting
              above the rows it is actually true of.
            */}
            The stat lines were ingested &mdash; these are discrepancies, not failures &mdash;
            so these games have been scored, possibly wrongly. Roughly one game in seven carries
            one.
          </p>
          <ProblemList rows={view.discrepancies} />
        </section>
      ) : null}
    </main>
  );
}
