import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { escrowProgram } from "@rostr/escrow";

/**
 * A read-only handle on the escrow program.
 *
 * The server never signs anything — a league is anchored by its commissioner's
 * wallet and a stake moved by the member's — so this exists purely to *read*
 * accounts back and check what they say. There is deliberately no keypair here
 * and nowhere to put one.
 *
 * Anchor's `Program` wants a provider, and a provider wants a wallet, but none
 * of the fetch paths touch it. The cast is the honest way to say "there is no
 * wallet and there must not be one" — the alternative is inventing a throwaway
 * keypair, which looks like a signer and would eventually be used as one.
 */
export function readOnlyEscrow() {
  const endpoint = process.env.SOLANA_RPC_URL;
  if (!endpoint) {
    throw new EscrowConfigError(
      "SOLANA_RPC_URL is not set, so an on-chain anchor cannot be verified.",
    );
  }

  const connection = new Connection(endpoint, "confirmed");
  const provider = new AnchorProvider(connection, {} as Wallet, {
    commitment: "confirmed",
  });

  return { connection, program: escrowProgram(provider) };
}

export class EscrowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowConfigError";
  }
}

/**
 * The anchoring wallet a browser names, parsed, or `null` if it cannot be one.
 *
 * The first refusal in the anchor route, before the ownership check. A key off
 * the ed25519 curve — a PDA, say — has no private key, so it cannot have signed
 * `initialize_league` as its payer; the all-zero default key is nobody's.
 */
export function parseAnchoringWallet(value: unknown): PublicKey | null {
  if (typeof value !== "string") return null;
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    return null;
  }
  if (key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes())) return null;
  return key;
}

/**
 * The wallet a league's on-chain address derives from, or why there is none.
 *
 * The address is `[b"league", id, commissioner]`, so every reader needs the
 * wallet that anchored — recorded once by the anchor route as
 * `leagues.chain_commissioner`. Never the connected wallet: a commissioner may
 * hold several, and only one of them seeds the address.
 *
 * Two refusals, and they ask for different things. `NOT_ANCHORED` is a step not
 * yet taken. `LEGACY_ANCHOR` is a league anchored under the old program, whose
 * address derived from the id alone; no wallet seeds it, so nothing derives it
 * any more, and guessing it would read an account no instruction can use.
 */
export type AnchoringWallet =
  | { readonly ok: true; readonly commissioner: PublicKey }
  | {
      readonly ok: false;
      readonly body: {
        readonly error: string;
        readonly reason: "NOT_ANCHORED" | "LEGACY_ANCHOR";
      };
    };

export function anchoringWallet(
  chain: { readonly anchoredAt: Date | null; readonly commissioner: string | null } | null,
): AnchoringWallet {
  if (!chain?.anchoredAt) {
    return {
      ok: false,
      body: { error: "This league is not anchored on-chain yet", reason: "NOT_ANCHORED" },
    };
  }
  if (!chain.commissioner) {
    return {
      ok: false,
      body: {
        error:
          "This league was anchored by an earlier version of the escrow program, which " +
          "this one cannot reach. Nothing can be done with it on-chain.",
        reason: "LEGACY_ANCHOR",
      },
    };
  }
  return { ok: true, commissioner: new PublicKey(chain.commissioner) };
}
