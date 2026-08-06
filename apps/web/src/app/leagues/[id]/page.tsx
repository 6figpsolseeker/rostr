import { notFound } from "next/navigation";
import { getLeagueRules, getWallets } from "@rostr/db";
import { RulesView } from "@/components/RulesView";
import { JoinPanel } from "@/components/JoinPanel";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

export default async function LeaguePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = db();

  const [league] = await client.query<{
    id: string;
    name: string;
    season: number;
    state: string;
    rules_hash: string;
    rules_uri: string | null;
  }>("SELECT id, name, season, state, rules_hash, rules_uri FROM leagues WHERE id = $1", [id]);

  if (!league) notFound();

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const [teams] = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM teams WHERE league_id = $1",
    [id],
  );
  const taken = Number(teams?.count ?? 0);

  // Resolved server-side so the panel opens on the right step rather than
  // flashing "sign in" at someone who already is.
  const user = await currentUser();
  const wallets = user ? await getWallets(client, user.id) : [];

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{league.name}</h1>
        <p className="text-sm text-white/60">
          {league.season} season · {taken}/{stored.rules.league.maxTeams} teams ·{" "}
          {league.state.toLowerCase()}
        </p>
        <a
          href={`/leagues/${league.id}/draft`}
          className="inline-block text-sm text-[--color-turf] hover:underline"
        >
          Draft room →
        </a>
      </header>

      {/*
        The rules render above the join control, always, and in full. A join
        button placed before the rules would make "shown before you join" a
        technicality rather than a fact.
      */}
      <RulesView rules={stored.rules} hash={stored.hash} />

      <JoinPanel
        leagueId={league.id}
        leagueName={league.name}
        open={league.state === "FORMING" && taken < stored.rules.league.maxTeams}
        signedIn={user !== null}
        linkedWallets={wallets.map((wallet) => wallet.address)}
      />

      {league.rules_uri && (
        <p className="text-xs text-white/40">
          Rule document: <span className="font-mono break-all">{league.rules_uri}</span>
        </p>
      )}
    </div>
  );
}
