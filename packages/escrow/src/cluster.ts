import type { Connection } from "@solana/web3.js";

/**
 * Which chain a thing is on.
 *
 * This matters more here than in most Solana apps, because **the PDA is
 * byte-identical on every cluster**. A league anchored on devnet and the same
 * league anchored on mainnet derive the same address from the same UUID, so
 * "the account exists" answers nothing on its own — a devnet anchor is not an
 * anchor for a mainnet stake, and the only thing separating them is which
 * endpoint you happened to ask.
 *
 * `leagues.chain_cluster` records the answer, and migration `0014` makes it
 * **write-once by trigger**. A wrong value there is permanent: `joinLeague`
 * gates on it, and there is no correcting row to write.
 */
export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

const CLUSTERS: readonly Cluster[] = ["mainnet-beta", "devnet", "testnet", "localnet"];

/**
 * The genesis hash of each public cluster — the chain's own cryptographic
 * identity, asked of the node rather than inferred from its URL.
 *
 * **Verified against the live public endpoints on 2026-08-11**, not recalled:
 *
 * ```
 * curl -s -X POST -H 'Content-Type: application/json' \
 *   -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' https://api.devnet.solana.com
 * ```
 *
 * These are genesis blocks, so they are as fixed as anything in this repo — a
 * value here changing would mean the chain itself was reset.
 *
 * **Localnet is deliberately absent.** `solana-test-validator` generates a fresh
 * genesis per ledger, so there is no constant to pin and no way to tell one
 * local chain from another. That is fine, and the reason is worth stating: a
 * local chain has no shared identity to protect and no real money on it. What
 * matters is that an unrecognised hash can never be mistaken for a *public*
 * cluster — see `clusterFromGenesisHash`.
 */
export const GENESIS_HASHES: Readonly<Record<Exclude<Cluster, "localnet">, string>> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};

/**
 * The token a pot is denominated in, per cluster.
 *
 * **Verified against the live chains on 2026-08-13**, not recalled — the same
 * standard as {@link GENESIS_HASHES}, and for a sharper reason. A recalled
 * address that is one character wrong is not a typo here, it is a different
 * token, and the value is frozen into every league created under it:
 *
 * ```
 * curl -s -X POST -H 'Content-Type: application/json' \
 *   -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",{"encoding":"jsonParsed"}]}' \
 *   https://api.mainnet-beta.solana.com
 * ```
 *
 * Both answered `"decimals": 6` and `"program": "spl-token"`, which is what the
 * program requires: `POT_MINT_DECIMALS` in `lib.rs`, and legacy SPL rather than
 * Token-2022, whose mints the program rejects outright.
 *
 * **Why this is a constant and not a choice.** The buy-in cap is expressed in
 * base units, so "fifty" only means fifty dollars if the token is worth a
 * dollar. `docs/RULES.md` §7 tells members the $5–$50 bounds "bind every
 * caller" and reasons from that to what a league can lose — a sentence that
 * holds only if something decides the token. Nothing did: the mint arrived in
 * the create request body and was written into the signed rules unread, while
 * the fee recipient beside it was deliberately taken from server config
 * because "a client-supplied recipient would let them redirect ours". The mint
 * decides what the money *is*, which is the larger question of the two.
 *
 * **Testnet and localnet are deliberately absent**, and they are absent for
 * different reasons. Testnet has no USDC worth naming. Localnet has no fixed
 * mint at all — a fresh ledger per run, so the anchor tests create their own —
 * which is the same reason {@link GENESIS_HASHES} skips it. Both answer `null`
 * from {@link potMintFor}, and a caller with no mint refuses to create a pot
 * league rather than falling back to whatever it was handed.
 */
export const POT_MINTS: Readonly<Partial<Record<Cluster, string>>> = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

/**
 * The mint a pot must use on this cluster, or `null` where there is no answer.
 *
 * `localnetOverride` exists so a local validator can still exercise the pot
 * flow end to end, and it is **ignored on every public cluster** — passing one
 * while declaring mainnet does not widen mainnet, it is simply not read. That
 * asymmetry is the point: the escape hatch cannot become the hole. A local
 * chain has no shared identity and no real money on it, which is the same
 * reasoning that lets an unrecognised genesis hash read as `"localnet"`.
 */
export function potMintFor(cluster: Cluster, localnetOverride?: string): string | null {
  if (cluster === "localnet") return localnetOverride || null;
  return POT_MINTS[cluster] ?? null;
}

/**
 * The cluster a genesis hash identifies, or `"localnet"` for anything else.
 *
 * Answering `"localnet"` rather than `null` for an unknown hash is the fail-safe
 * direction, and it only works because callers *compare* the result against a
 * declared cluster rather than trusting it. Declare mainnet, get an
 * unrecognised chain, and this answers `"localnet"` — which does not match, so
 * the caller refuses. The unrecognised chain is never promoted to a public one.
 *
 * Two different private chains do both read as `"localnet"` and so satisfy each
 * other. That is accepted: a local chain is not a shared identity, and the
 * guarantee this protects — that a devnet anchor cannot back a mainnet stake —
 * is untouched by it.
 */
export function clusterFromGenesisHash(hash: string): Cluster {
  for (const [cluster, genesis] of Object.entries(GENESIS_HASHES)) {
    if (genesis === hash) return cluster as Cluster;
  }
  return "localnet";
}

/** A configured value, or `null` if it names no cluster we know. */
export function parseCluster(value: string | undefined | null): Cluster | null {
  if (!value) return null;
  return CLUSTERS.find((c) => c === value) ?? null;
}

/**
 * Ask the chain which chain it is.
 *
 * One round trip, and it replaces every form of guessing from the endpoint URL.
 * A deployment that points at a private RPC — which any real one does, since the
 * public nodes are rate-limited and the order draw alone makes ~30 sequential
 * calls — has a URL that says nothing at all about which cluster is behind it.
 */
export async function resolveCluster(connection: Connection): Promise<Cluster> {
  return clusterFromGenesisHash(await connection.getGenesisHash());
}

/**
 * The message shown when the chain the browser is connected to is not the one
 * this deployment runs on, or `null` when they agree.
 *
 * Separate from the component that renders it because `apps/web` cannot test
 * React — `vitest.config.ts` collects `.ts`, there is no jsdom environment, and
 * a comparison living inside a component would be verified only by being run in
 * production. The two mapping defects found in the anchor review were both in a
 * mapping, not in the comparison around it.
 */
export function clusterMismatch(declared: Cluster, actual: Cluster): string | null {
  if (declared === actual) return null;

  return (
    `Your wallet is connected to ${actual}, but this deployment runs on ` +
    `${declared}. Signing here would put a transaction on the wrong chain — ` +
    `and league accounts have the same address on every cluster, so nothing ` +
    `would look wrong until it was too late.`
  );
}
