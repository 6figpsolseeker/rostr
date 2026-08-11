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
