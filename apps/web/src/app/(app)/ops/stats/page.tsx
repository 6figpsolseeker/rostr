import { notFound } from "next/navigation";
import { unresolvedStatsProblems } from "@rostr/db";
import { NFL } from "@rostr/core";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import { buildOpsView } from "@/lib/ops";
import type { ProblemRow } from "@/lib/ops";

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

function StatusChip({ row }: { row: ProblemRow }) {
  const label =
    row.status === "NOT_FINAL"
      ? "Game not final"
      : row.status === "OPEN"
        ? `${row.hoursSinceFinal}h of ${row.windowHours}h`
        : `Window closed (${row.windowHours}h)`;

  const tone =
    row.status === "OPEN"
      ? "border-amber-500/40 text-amber-300"
      : row.status === "NOT_FINAL"
        ? "border-nocturne-neutral-700 text-nocturne-neutral-400"
        : "border-nocturne-neutral-800 text-nocturne-neutral-600";

  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[11px] tracking-wide ${tone}`}
    >
      {label}
    </span>
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
            <StatusChip row={row} />
          </div>
          {/*
            The provider's own words, unedited. Summarising here would put a
            second description of the fault next to the one the translator
            wrote, and the translator's is the one that names the fields.
          */}
          <p className="mt-3 border-t border-nocturne-neutral-800 pt-3 text-[13.5px] leading-[1.6] break-words text-nocturne-neutral-400">
            {row.problem}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default async function OpsStatsPage() {
  const user = await currentUser();
  if (!isOperator(user?.email)) notFound();

  const problems = await unresolvedStatsProblems(db(), NFL.key, 50);
  const view = buildOpsView(problems, new Date());

  return (
    <main className="mx-auto max-w-[900px] px-6 py-14">
      <p className="font-mono text-[11px] tracking-[0.16em] text-nocturne-neutral-500 uppercase">
        rostr ops
      </p>
      <h1 className="mt-3 text-[32px] leading-[1.1] font-medium tracking-[-0.02em]">
        Stats problems
      </h1>
      <p className="mt-4 max-w-[62ch] text-[14.5px] leading-[1.62] text-nocturne-neutral-400">
        Games where the provider&rsquo;s own numbers disagreed with each other. The stat lines
        were still ingested &mdash; these are discrepancies, not failures &mdash; so every one
        of these games has been scored, possibly wrongly.
      </p>

      <p className="mt-6 font-mono text-[12px] text-nocturne-neutral-500">
        {view.total === 0
          ? "none outstanding"
          : `${view.total} outstanding${view.shown < view.total ? `, showing ${view.shown}` : ""}`}
      </p>

      {view.total === 0 ? (
        <p className="mt-8 rounded-[4px] border border-nocturne-neutral-800 p-5 text-[13.5px] leading-[1.6] text-nocturne-neutral-500">
          Nothing flagged. Worth knowing what that does and does not mean: it says no game has
          tripped one of the translator&rsquo;s checks, not that every score is right. A defect
          in a category nothing cross-checks looks exactly like this.
        </p>
      ) : null}

      {view.actionable.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-[15px] font-medium">Still correctable</h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.6] text-nocturne-neutral-500">
            Inside the correction window, or not yet final. A fix applied to these still reaches
            the scores.
          </p>
          <ProblemList rows={view.actionable} />
        </section>
      ) : null}

      {view.expired.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-[15px] font-medium text-nocturne-neutral-400">Past the window</h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.6] text-nocturne-neutral-500">
            {/*
              Kept on screen rather than dropped. A game nobody can fix is still
              evidence about the provider, and a growing tail of these is the
              argument for a second source at ingest rather than a page.
            */}
            A finalised week is never rescored, so these can no longer be changed. They are
            listed because the pattern matters even when the individual game is settled.
          </p>
          <ProblemList rows={view.expired} />
        </section>
      ) : null}
    </main>
  );
}
