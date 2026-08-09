import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
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
