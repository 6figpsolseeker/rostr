import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { GENESIS_HASHES } from "@rostr/escrow";
import { assertRpcCluster, ClusterConfigError, declaredCluster } from "./cluster.js";

/**
 * `SOLANA_CLUSTER` is now the one declaration, and the browser and the server
 * are checked against it. Before this there were three independent sources of
 * "which chain" and no comparison between any two of them.
 */

// `vi.stubEnv` rather than assigning `process.env` directly: NODE_ENV is typed
// read-only, and this restores every variable together rather than one at a
// time, so a test that forgets one cannot leak into the next.
afterEach(() => {
  vi.unstubAllEnvs();
});

const asConnection = (rpcEndpoint: string, genesis: string): Connection =>
  ({
    rpcEndpoint,
    getGenesisHash: () => Promise.resolve(genesis),
  }) as unknown as Connection;

describe("declaredCluster", () => {
  it.each(["mainnet-beta", "devnet", "testnet", "localnet"])(
    "returns %s as declared",
    (value) => {
      vi.stubEnv("SOLANA_CLUSTER", value);
      expect(declaredCluster()).toBe(value);
    },
  );

  it("defaults to devnet in development", () => {
    // Devnet and not mainnet, because devnet is the fallback that fails
    // *visibly*: nothing verifies, nobody loses anything, and the missing
    // config surfaces in minutes.
    vi.stubEnv("SOLANA_CLUSTER", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(declaredCluster()).toBe("devnet");
  });

  it("refuses in production rather than defaulting", () => {
    // The deployment guaranteed to have this unset is the one nobody
    // configured, which is exactly the one that must not guess.
    vi.stubEnv("SOLANA_CLUSTER", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => declaredCluster()).toThrow(ClusterConfigError);
    expect(() => declaredCluster()).toThrow(/required in production/);
  });

  it("refuses a value that names no cluster, in every environment", () => {
    // `mainnet` is the obvious typo for `mainnet-beta`, and silently correcting
    // it would be guessing about the one thing this file exists to stop
    // guessing about. It throws in development too — a typo is a mistake
    // wherever it happens, unlike an absent variable, which is normal locally.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SOLANA_CLUSTER", "mainnet");
    expect(() => declaredCluster()).toThrow(/names no cluster/);
  });
});

describe("assertRpcCluster", () => {
  it("returns the declared cluster when the node agrees", async () => {
    vi.stubEnv("SOLANA_CLUSTER", "devnet");
    const connection = asConnection("https://rostr.example/rpc", GENESIS_HASHES.devnet);
    await expect(assertRpcCluster(connection)).resolves.toBe("devnet");
  });

  it("refuses when SOLANA_RPC_URL is a different chain than declared", async () => {
    // The failure this prevents is not a bad request — it is the anchor route
    // reading mainnet, finding no account, answering NOT_FOUND, and telling a
    // commissioner whose transaction landed correctly on devnet to retry.
    vi.stubEnv("SOLANA_CLUSTER", "mainnet-beta");
    const connection = asConnection("https://rostr.example/rpc", GENESIS_HASHES.devnet);

    await expect(assertRpcCluster(connection)).rejects.toThrow(ClusterConfigError);
    await expect(assertRpcCluster(connection)).rejects.toThrow(/says mainnet-beta/);
  });

  it("refuses an unrecognised chain claiming to be a public one", async () => {
    // A local validator, a fork, or a proxy in front of the wrong node all
    // arrive here as an unknown genesis hash. None of them may satisfy a
    // mainnet declaration.
    vi.stubEnv("SOLANA_CLUSTER", "mainnet-beta");
    const connection = asConnection(
      "https://api.mainnet-beta.solana.com",
      "not-a-real-genesis",
    );

    await expect(assertRpcCluster(connection)).rejects.toThrow(ClusterConfigError);
  });

  it("does not reach the network when the declaration is already unusable", async () => {
    // Ordering matters: a misconfigured deployment should get the config error,
    // not a timeout from whatever endpoint happened to be set.
    vi.stubEnv("SOLANA_CLUSTER", "mainnet");
    const connection = {
      rpcEndpoint: "https://rostr.example/rpc",
      getGenesisHash: () => Promise.reject(new Error("should not be called")),
    } as unknown as Connection;

    await expect(assertRpcCluster(connection)).rejects.toThrow(/names no cluster/);
  });
});
