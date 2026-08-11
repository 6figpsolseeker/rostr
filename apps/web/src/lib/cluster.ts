import "server-only";

import type { Connection } from "@solana/web3.js";
import { parseCluster, resolveCluster, type Cluster } from "@rostr/escrow";

/**
 * Which chain this deployment runs on. One answer, and everything else is
 * checked against it.
 *
 * There used to be **three independent sources** of that, none of which was
 * compared with any other:
 *
 * | Where                | Variable                       | Unset                 |
 * | -------------------- | ------------------------------ | --------------------- |
 * | Browser — *signs*    | `NEXT_PUBLIC_SOLANA_RPC_URL`   | **mainnet-beta**      |
 * | Server — *verifies*  | `SOLANA_RPC_URL`               | throws                |
 * | Join gate            | `SOLANA_CLUSTER`               | **no check at all**   |
 *
 * The dangerous one was client-side, optional, and defaulted to real money. A
 * commissioner with it unset signed `initialize_league` against **mainnet**
 * while the server read devnet, found nothing, and returned `NOT_FOUND` — which
 * the route documents as "retry". The account is real, it is on the wrong chain,
 * it cost mainnet rent, and the PDA derives from the league's UUID with no
 * `close` instruction, so that league can never be anchored there again. Worse
 * downstream: `deposit` is permissionless once a league exists, so a member
 * could put real USDC into a vault this deployment never looks at.
 *
 * `SOLANA_CLUSTER` is now the declaration and the other two are checked against
 * it — the server's RPC by its genesis hash, the browser's by the same, at
 * runtime.
 */
export class ClusterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterConfigError";
  }
}

/**
 * The cluster this deployment declares itself to be on.
 *
 * **Required in production, `devnet` in development.** This mirrors
 * `cronForbidden` deliberately — open locally, closed where it counts — because
 * the alternative shapes are both worse. Defaulting to mainnet is what caused
 * this; defaulting to devnet in production would silently anchor real leagues on
 * a chain that gets wiped, which looks like it works right up until it doesn't.
 *
 * Refusing costs one line in an env file. There is no reading of an absent
 * `SOLANA_CLUSTER` that is safe enough to assume in production.
 */
export function declaredCluster(): Cluster {
  const raw = process.env["SOLANA_CLUSTER"];
  const parsed = parseCluster(raw);
  if (parsed) return parsed;

  if (raw) {
    throw new ClusterConfigError(
      `SOLANA_CLUSTER is "${raw}", which names no cluster. Use one of ` +
        `mainnet-beta, devnet, testnet, localnet.`,
    );
  }

  if (process.env.NODE_ENV === "production") {
    throw new ClusterConfigError(
      "SOLANA_CLUSTER is not set. It is required in production: league " +
        "accounts have the same address on every cluster, so without it a " +
        "devnet anchor and a mainnet one are indistinguishable.",
    );
  }

  return "devnet";
}

/**
 * Confirm `SOLANA_RPC_URL` really is the declared cluster, and return it.
 *
 * Asks the node for its genesis hash rather than reading its URL. Every real
 * deployment uses a private RPC — the public endpoints are rate-limited and the
 * order draw alone makes ~30 sequential calls — and a private endpoint's
 * hostname says nothing about which chain is behind it. The URL is a label
 * somebody typed; the genesis hash is the chain's own identity.
 *
 * Callers use the **return value** as the cluster to record, so there is no
 * second path by which an unverified value could reach the database.
 */
export async function assertRpcCluster(connection: Connection): Promise<Cluster> {
  const declared = declaredCluster();
  const actual = await resolveCluster(connection);

  if (actual !== declared) {
    throw new ClusterConfigError(
      `SOLANA_CLUSTER says ${declared} but SOLANA_RPC_URL ` +
        `(${connection.rpcEndpoint}) is ${actual}. Recording an anchor now ` +
        `would write the wrong cluster permanently — migration 0014 makes ` +
        `leagues.chain_cluster write-once, and joinLeague gates on it.`,
    );
  }

  return declared;
}
