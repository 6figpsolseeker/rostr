import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  browserRpcEndpoint,
  embeddedSolanaAddress,
  privyChain,
  privyWalletStatus,
  signTransactionWithBytes,
  websocketEndpoint,
} from "./privy-wallet";

const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

describe("privyChain", () => {
  it("names the chain for every public cluster", () => {
    expect(privyChain("mainnet-beta")).toBe("solana:mainnet");
    expect(privyChain("devnet")).toBe("solana:devnet");
    expect(privyChain("testnet")).toBe("solana:testnet");
  });

  it("has no chain for a local validator", () => {
    expect(privyChain("localnet")).toBeNull();
  });
});

/** A signer that behaves like Privy's: bytes in, the same message signed, bytes out. */
function bytesSigner(keypair: Keypair) {
  return async (serialized: Uint8Array): Promise<Uint8Array> => {
    try {
      const tx = VersionedTransaction.deserialize(serialized);
      tx.sign([keypair]);
      return tx.serialize();
    } catch {
      const tx = Transaction.from(serialized);
      tx.partialSign(keypair);
      return new Uint8Array(tx.serialize({ requireAllSignatures: false }));
    }
  };
}

function transfer(from: PublicKey): Transaction {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  tx.feePayer = from;
  tx.recentBlockhash = BLOCKHASH;
  return tx;
}

describe("signTransactionWithBytes", () => {
  it("returns a legacy transaction carrying a valid signature from the signer", async () => {
    const payer = Keypair.generate();
    const signed = await signTransactionWithBytes(
      transfer(payer.publicKey),
      bytesSigner(payer),
    );

    expect(signed).toBeInstanceOf(Transaction);
    expect(signed.verifySignatures()).toBe(true);
    expect(signed.signatures[0]?.publicKey.equals(payer.publicKey)).toBe(true);
  });

  it("serialises an unsigned transaction rather than refusing it", async () => {
    // web3.js throws on `serialize()` when a required signature is missing, and
    // the whole point of this call is that it is missing.
    const payer = Keypair.generate();
    let seen: Uint8Array | null = null;
    await signTransactionWithBytes(transfer(payer.publicKey), async (bytes) => {
      seen = bytes;
      return bytesSigner(payer)(bytes);
    });
    expect(seen).not.toBeNull();
  });

  it("returns a versioned transaction as a versioned transaction", async () => {
    const payer = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();

    const signed = await signTransactionWithBytes(
      new VersionedTransaction(message),
      bytesSigner(payer),
    );

    expect(signed).toBeInstanceOf(VersionedTransaction);
    expect(signed.signatures[0]?.some((byte) => byte !== 0)).toBe(true);
  });
});

describe("embeddedSolanaAddress", () => {
  const embedded = {
    type: "wallet",
    address: "BrQ6XPXe1x64UFzmBjtwNuAzeELjvjEWKZ9GaJTaqyY4",
    chainType: "solana",
    walletClientType: "privy",
    connectorType: "embedded",
  };

  it("finds the Solana wallet Privy generated", () => {
    expect(
      embeddedSolanaAddress({
        linkedAccounts: [{ type: "email", address: "a@b.c" }, embedded],
      }),
    ).toBe(embedded.address);
  });

  it("ignores an external wallet and an Ethereum embedded wallet", () => {
    expect(
      embeddedSolanaAddress({
        linkedAccounts: [
          { ...embedded, walletClientType: "phantom", connectorType: "solana_adapter" },
          { ...embedded, chainType: "ethereum", address: "0xabc" },
          // Privy-branded but not generated: the connector is what says Privy holds the key.
          { ...embedded, connectorType: "injected" },
        ],
      }),
    ).toBeNull();
  });

  it("is null for an account with no wallet yet", () => {
    expect(embeddedSolanaAddress({ linkedAccounts: [] })).toBeNull();
  });
});

describe("browserRpcEndpoint", () => {
  it("uses the configured endpoint when there is one", () => {
    expect(browserRpcEndpoint("devnet", "https://devnet.helius-rpc.com/?api-key=k")).toBe(
      "https://devnet.helius-rpc.com/?api-key=k",
    );
  });

  it("falls back to the cluster's public endpoint, including for a blank override", () => {
    expect(browserRpcEndpoint("devnet", undefined)).toBe("https://api.devnet.solana.com");
    expect(browserRpcEndpoint("devnet", "  ")).toBe("https://api.devnet.solana.com");
    expect(browserRpcEndpoint("localnet", undefined)).toBe("http://127.0.0.1:8899");
  });
});

describe("websocketEndpoint", () => {
  it("swaps the scheme and keeps the host, path and API key", () => {
    expect(websocketEndpoint("https://api.devnet.solana.com")).toBe(
      "wss://api.devnet.solana.com/",
    );
    expect(websocketEndpoint("https://devnet.helius-rpc.com/?api-key=k")).toBe(
      "wss://devnet.helius-rpc.com/?api-key=k",
    );
    expect(websocketEndpoint("http://127.0.0.1:8899")).toBe("ws://127.0.0.1:8899/");
  });
});

describe("privyWalletStatus", () => {
  const base = {
    ready: true,
    authenticated: true,
    walletsReady: true,
    embeddedAddress: "BrQ6XPXe1x64UFzmBjtwNuAzeELjvjEWKZ9GaJTaqyY4",
    found: true,
  };

  it("is ready once the generated wallet is among Privy's wallets", () => {
    expect(privyWalletStatus(base)).toBe("ready");
  });

  it("is loading while Privy starts, and while a new wallet is still being created", () => {
    expect(privyWalletStatus({ ...base, ready: false, found: false })).toBe("loading");
    expect(privyWalletStatus({ ...base, walletsReady: false, found: false })).toBe("loading");
    expect(privyWalletStatus({ ...base, embeddedAddress: null, found: false })).toBe("loading");
  });

  it("is none when nobody is logged in to Privy", () => {
    expect(
      privyWalletStatus({ ...base, authenticated: false, embeddedAddress: null, found: false }),
    ).toBe("none");
  });

  it("is missing, not loading, when Privy has loaded and the wallet is not there", () => {
    expect(privyWalletStatus({ ...base, found: false })).toBe("missing");
  });
});
