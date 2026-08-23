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

// ---------------------------------------------------------------------------
// Wallet ownership
// ---------------------------------------------------------------------------

const LINK_PREFIX = "rostr: link wallet";

export interface WalletLinkMessageInput {
  readonly walletAddress: string;
  readonly email: string;
  /** Single-use, server-issued, short-lived. */
  readonly nonce: string;
}

/**
 * The text a wallet signs to prove its holder controls it.
 *
 * Unlike the join message this **carries a nonce**, and the difference is the
 * whole point. A join signature is a permanent record of consent, so it must be
 * reconstructible from stored data years later. This one is an authentication
 * challenge: a signature captured once must not work twice.
 *
 * Without it, linking a wallet would be typing an address — and anyone could
 * claim any address, including one already holding a league stake.
 */
export function buildWalletLinkMessage(input: WalletLinkMessageInput): string {
  return [
    LINK_PREFIX,
    "",
    `Account: ${input.email}`,
    `Wallet: ${input.walletAddress}`,
    `Nonce: ${input.nonce}`,
    "",
    "Signing proves you hold this wallet. It moves no funds and",
    "approves no transaction.",
  ].join("\n");
}

/** Verify a signature over the wallet link message. */
export function verifyWalletLinkSignature(
  input: WalletLinkMessageInput,
  signatureBase58: string,
): boolean {
  try {
    const message = new TextEncoder().encode(buildWalletLinkMessage(input));
    const signature = bs58.decode(signatureBase58);
    const publicKey = bs58.decode(input.walletAddress);

    if (signature.length !== 64 || publicKey.length !== 32) return false;

    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wallet sign-in
// ---------------------------------------------------------------------------

/**
 * Deliberately **not** `LINK_PREFIX`.
 *
 * A link signature and a sign-in signature prove the same fact — that somebody
 * holds this key — and authorise entirely different things. Sharing one message
 * would let a signature gathered for one purpose be replayed for the other: a
 * linking prompt, approved by somebody who thought they were adding a wallet to
 * an account they were already inside, would double as a session for that
 * account. Two prefixes make the two signatures structurally non-interchangeable
 * rather than merely intended to be.
 */
const SIGNIN_PREFIX = "rostr: sign in";

export interface WalletSignInMessageInput {
  readonly walletAddress: string;
  /** Single-use, server-issued, short-lived. */
  readonly nonce: string;
}

/**
 * The text a returning member signs instead of fetching an emailed code.
 *
 * **No email in it, unlike the link message.** The signer has not proved who
 * they are yet — that is what this signature is for — so putting the account's
 * address in the prompt would disclose it to whoever is holding the wallet
 * before anything has been established. It also is not needed: the server looks
 * the account up from the wallet, and the nonce is what ties this signature to
 * one live challenge.
 *
 * The reassurance line is kept word for word from the link message. It is the
 * sentence that stops a wallet prompt reading like a transaction approval, and
 * that concern does not change with the purpose.
 */
export function buildWalletSignInMessage(input: WalletSignInMessageInput): string {
  return [
    SIGNIN_PREFIX,
    "",
    `Wallet: ${input.walletAddress}`,
    `Nonce: ${input.nonce}`,
    "",
    "Signing proves you hold this wallet. It moves no funds and",
    "approves no transaction.",
  ].join("\n");
}

/** Verify a signature over the wallet sign-in message. */
export function verifyWalletSignInSignature(
  input: WalletSignInMessageInput,
  signatureBase58: string,
): boolean {
  try {
    const message = new TextEncoder().encode(buildWalletSignInMessage(input));
    const signature = bs58.decode(signatureBase58);
    const publicKey = bs58.decode(input.walletAddress);

    if (signature.length !== 64 || publicKey.length !== 32) return false;

    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
