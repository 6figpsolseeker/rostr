import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import {
  clusterFromGenesisHash,
  clusterMismatch,
  GENESIS_HASHES,
  parseCluster,
  resolveCluster,
  type Cluster,
} from "./cluster.js";
import { clusterOf } from "./verify.js";

/**
 * The PDA is byte-identical on every cluster, so "which chain" is not cosmetic
 * here — it is the only thing separating a devnet anchor from a mainnet stake.
 * `leagues.chain_cluster` records the answer and migration `0014` makes it
 * write-once, so a wrong one is permanent.
 */

const asConnection = (rpcEndpoint: string, genesis?: string): Connection =>
  ({
    rpcEndpoint,
    getGenesisHash: () => Promise.resolve(genesis ?? ""),
  }) as unknown as Connection;

describe("clusterFromGenesisHash", () => {
  it.each(Object.entries(GENESIS_HASHES))("identifies %s", (cluster, hash) => {
    expect(clusterFromGenesisHash(hash)).toBe(cluster);
  });

  it("never promotes an unrecognised chain to a public one", () => {
    // The whole safety argument rests on this. A local validator's genesis is
    // random per ledger, and so is a fork's — neither may be allowed to pass as
    // devnet or mainnet, because the caller compares this against a *declared*
    // cluster and refuses on a mismatch.
    expect(clusterFromGenesisHash("3nHo8B1zpqZ8P4hPGkYbdF2rMFHF6vjqRE7dGgVrxYRt")).toBe(
      "localnet",
    );
    expect(clusterFromGenesisHash("")).toBe("localnet");
  });

  it("holds the hashes the public endpoints actually serve", () => {
    // Verified 2026-08-11 by asking the live nodes, not from memory:
    //   curl -sX POST -H 'Content-Type: application/json' \
    //     -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' \
    //     https://api.mainnet-beta.solana.com
    // These are genesis blocks: a change here means the chain was reset, not
    // that the constant drifted.
    expect(GENESIS_HASHES).toEqual({
      "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    });
  });
});

describe("parseCluster", () => {
  it.each(["mainnet-beta", "devnet", "testnet", "localnet"])("accepts %s", (value) => {
    expect(parseCluster(value)).toBe(value as Cluster);
  });

  it.each([undefined, null, "", "mainnet", "MAINNET-BETA", "prod"])(
    "refuses %s rather than guessing",
    (value) => {
      // `mainnet` and `MAINNET-BETA` are the plausible typos, and both must be
      // refused rather than helpfully corrected: the caller's response to null
      // is to stop, and that is the safe direction.
      expect(parseCluster(value)).toBeNull();
    },
  );
});

describe("resolveCluster", () => {
  it("asks the node rather than reading its URL", async () => {
    // The endpoint says mainnet in every way a human would read it, and the
    // chain behind it is devnet. This is not a contrived case — it is what a
    // misconfigured private RPC looks like.
    const connection = asConnection("https://mainnet.rostr.example/rpc", GENESIS_HASHES.devnet);
    await expect(resolveCluster(connection)).resolves.toBe("devnet");
  });
});

describe("clusterOf", () => {
  it.each([
    ["https://api.devnet.solana.com", "devnet"],
    ["https://api.testnet.solana.com", "testnet"],
    ["https://api.mainnet-beta.solana.com", "mainnet-beta"],
    ["http://127.0.0.1:8899", "localnet"],
    ["http://localhost:8899", "localnet"],
  ])("reads %s as %s", (endpoint, expected) => {
    expect(clusterOf(asConnection(endpoint))).toBe(expected);
  });

  it("throws on an endpoint it cannot classify, rather than answering mainnet", () => {
    // This was the bug. Every real deployment uses a private RPC — the public
    // nodes are rate-limited and the order draw alone makes ~30 sequential
    // calls — so an ordinary devnet endpoint matched no branch and was recorded
    // as mainnet, permanently, in a column `joinLeague` gates on.
    expect(() => clusterOf(asConnection("https://rostr.rpcpool.com/abc123"))).toThrow(
      /Cannot tell which cluster/,
    );
  });
});

describe("clusterMismatch", () => {
  it("is silent when the browser and the deployment agree", () => {
    expect(clusterMismatch("devnet", "devnet")).toBeNull();
  });

  it("names both chains when they differ", () => {
    const message = clusterMismatch("devnet", "mainnet-beta");
    expect(message).toContain("mainnet-beta");
    expect(message).toContain("devnet");
  });

  it("says why nothing would look wrong, because nothing would", () => {
    // A wrong-network warning that only says "wrong network" gets dismissed.
    // The reason it is dangerous here specifically is that the address is the
    // same on both chains, so every screen keeps rendering normally.
    expect(clusterMismatch("mainnet-beta", "devnet")).toMatch(/same address on every cluster/);
  });
});
