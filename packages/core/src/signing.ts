/**
 * Join consent.
 *
 * Joining a league is not a checkbox. A member signs a message naming the exact
 * rule set they are agreeing to, and that signature is stored permanently. It is
 * what makes "the rules were shown before you joined" provable rather than
 * asserted.
 *
 * ## The message format is part of the protocol
 *
 * Wallets display this text to the user before they sign, so it has to be
 * readable by a person. It also has to be reproducible byte-for-byte by anyone
 * verifying later — a signature over a message nobody else can reconstruct
 * proves nothing.
 *
 * Changing this format invalidates verification of every signature already
 * collected. Treat it like the canonical encoding: fixed.
 */

import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

/** Prefix so a rostr signature can never be replayed as another app's message. */
const PREFIX = "rostr: join league";

export interface JoinMessageInput {
  readonly leagueId: string;
  readonly leagueName: string;
  readonly rulesHash: string;
  readonly walletAddress: string;
  readonly seasonYear: number;
}

/**
 * Build the exact text a member signs.
 *
 * Deterministic in its inputs — no timestamps, no nonces. The signature is a
 * permanent record of consent, not a session token, and a verifier years later
 * must be able to rebuild it from stored data alone.
 */
export function buildJoinMessage(input: JoinMessageInput): string {
  return [
    PREFIX,
    "",
    `League: ${input.leagueName}`,
    `League ID: ${input.leagueId}`,
    `Season: ${input.seasonYear}`,
    `Rules hash: ${input.rulesHash}`,
    `Wallet: ${input.walletAddress}`,
    "",
    "These rules are final. They cannot be changed by anyone,",
    "including the commissioner, for the life of this league.",
  ].join("\n");
}

/**
 * Verify a signature over the join message.
 *
 * Returns false rather than throwing on malformed input: a bad signature and a
 * malformed one are the same outcome to a caller, and throwing would invite a
 * try/catch that swallows both.
 */
export function verifyJoinSignature(input: JoinMessageInput, signatureBase58: string): boolean {
  try {
    const message = new TextEncoder().encode(buildJoinMessage(input));
    const signature = bs58.decode(signatureBase58);
    const publicKey = bs58.decode(input.walletAddress);

    if (signature.length !== 64 || publicKey.length !== 32) return false;

    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Whether a string is a plausible base58-encoded ed25519 public key. */
export function isValidWalletAddress(address: string): boolean {
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}
