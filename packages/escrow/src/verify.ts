/**
 * Reading a league back off the chain, and checking it says what we think.
 *
 * This is the half of anchoring that must not be trusted to a browser. A client
 * reports "I anchored it, here is the signature", and a signature proves only
 * that *some* transaction happened. What makes the record a fact is fetching the
 * account and finding our rules hash in it.
 *
 * It lives here rather than in the route deliberately. The route needs a session,
 * a database and an HTTP request to exercise; this needs a connection and a
 * deployed program, which the program test suite already has — so the part where
 * the bugs actually are gets tested against a real chain instead of a mock.
 *
 * The bugs in question are all shape, not logic: 32 raw bytes on-chain versus a
 * 64-character hex string in Postgres, a `number[]` from Anchor versus a
 * `Uint8Array`, and a comparison that quietly succeeds because both sides
 * stringify to `[object Object]`.
 */

import type { Program } from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";

import { payoutArray } from "./instructions.js";
import { leaguePda, membershipPda } from "./program.js";
import type { RostrEscrow } from "./types.js";

/** A league's frozen terms, as they exist on-chain. */
export interface OnChainLeague {
  readonly address: PublicKey;
  /** Lower-case hex, to compare directly against `leagues.rules_hash`. */
  readonly rulesHash: string;
  readonly hasPot: boolean;
  /** Base units as a decimal string. Zero for a free league. */
  readonly buyIn: string;
  readonly tokenMint: string;
  /**
   * Unix seconds after which a stake may be withdrawn unilaterally, as a
   * decimal string.
   *
   * A string rather than a number because this is an `i64` the creator chooses
   * freely — the program requires only that it is in the future, so `i64::MAX`
   * is a legal value and is exactly the hostile one: it locks every deposit
   * forever. `BN.toNumber()` **throws** above 2^53, so decoding it as a number
   * turns the worst case this check exists to catch into an exception thrown
   * before any comparison happens.
   */
  readonly refundUnlockAt: string;
  readonly feeBps: number;
  /** Base58; where the settlement fee is paid. */
  readonly feeRecipient: string;
  /** Payout split in basis points, positional (see `PRIZE_ORDER`). */
  readonly payoutBps: readonly number[];
  readonly maxTeams: number;
  readonly memberCount: number;
}

/**
 * Bytes to lower-case hex.
 *
 * Anchor hands back a `number[]` for a `[u8; 32]`, Postgres stores `char(64)`.
 * Doing this by hand rather than reaching for Buffer keeps it working in a
 * browser bundle, where Buffer is a polyfill that may or may not be present.
 */
export function bytesToHex(bytes: Uint8Array | readonly number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The inverse, for handing a stored hash to an instruction. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`not a 32-byte hex hash: ${hex}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Read a league's account, or `null` when it does not exist.
 *
 * A missing account is the ordinary case — a league created in the database but
 * not yet anchored — so it is a return value rather than a throw.
 */
export async function fetchOnChainLeague(
  program: Program<RostrEscrow>,
  leagueId: string,
): Promise<OnChainLeague | null> {
  const address = leaguePda(leagueId);

  const account = await program.account["league"]?.fetchNullable(address);
  if (!account) return null;

  const raw = account as {
    rulesHash: number[];
    hasPot: boolean;
    buyIn: { toString(): string };
    tokenMint: PublicKey;
    refundUnlockAt: { toString(): string };
    feeBps: number;
    feeRecipient: PublicKey;
    payoutBps: number[];
    maxTeams: number;
    memberCount: number;
  };

  return {
    address,
    rulesHash: bytesToHex(raw.rulesHash),
    hasPot: raw.hasPot,
    buyIn: raw.buyIn.toString(),
    tokenMint: raw.tokenMint.toBase58(),
    refundUnlockAt: raw.refundUnlockAt.toString(),
    feeBps: raw.feeBps,
    feeRecipient: raw.feeRecipient.toBase58(),
    payoutBps: [...raw.payoutBps],
    maxTeams: raw.maxTeams,
    memberCount: raw.memberCount,
  };
}

export type AnchorVerdict =
  | { readonly ok: true; readonly league: OnChainLeague }
  | { readonly ok: false; readonly reason: "NOT_FOUND" }
  | {
      readonly ok: false;
      readonly reason: "HASH_MISMATCH";
      readonly onChain: string;
      readonly expected: string;
    };

/**
 * Confirm a league is anchored, and anchored with **our** rules.
 *
 * The hash comparison is the entire point. Finding an account at the right
 * address proves only that somebody created one; a league is anchored when the
 * document members are about to sign is the document the chain holds.
 *
 * Case-insensitive because the two sides come from different places — Postgres
 * `char(64)` and bytes formatted here — and a mismatch of case would be a
 * spurious failure on identical data.
 */
export async function verifyLeagueAnchor(
  program: Program<RostrEscrow>,
  leagueId: string,
  expectedRulesHash: string,
): Promise<AnchorVerdict> {
  const league = await fetchOnChainLeague(program, leagueId);
  if (!league) return { ok: false, reason: "NOT_FOUND" };

  if (league.rulesHash.toLowerCase() !== expectedRulesHash.toLowerCase()) {
    return {
      ok: false,
      reason: "HASH_MISMATCH",
      onChain: league.rulesHash,
      expected: expectedRulesHash.toLowerCase(),
    };
  }

  return { ok: true, league };
}

export type JoinVerdict =
  | {
      readonly ok: true;
      readonly membership: { readonly league: PublicKey; readonly member: PublicKey };
    }
  | { readonly ok: false; readonly reason: "NOT_FOUND" };

/**
 * Confirm a member has actually joined a league on-chain.
 *
 * The client reports "I joined it, here is the transaction signature", and a
 * signature proves only that *some* transaction happened. What makes the record
 * a fact is that an account exists at the `Membership` PDA for this league and
 * this wallet — which only `join_league` can create, and only with that wallet
 * as a signer paying its rent.
 *
 * **Be precise about what this does and does not establish.** The PDA is
 * derived from `(league, member)`, and the program writes `membership.member`
 * from the same key it seeds with, so re-reading the account and comparing
 * `member` against the key we derived from would be a tautology — it can never
 * disagree. There is deliberately no such check here, and no `MEMBER_MISMATCH`
 * verdict, because a check that cannot fail reads as a guarantee and is not one.
 *
 * So this proves *somebody holding that wallet's key signed `join_league` for
 * that league*. It does **not** prove the caller is that somebody. Binding the
 * wallet to a person is the caller's job and cannot be done from here — the
 * route derives the wallet from the caller's own consent row rather than
 * accepting one in a request.
 *
 * Contrast `verifyLeagueAnchor`, which genuinely can disagree: it compares the
 * on-chain rules hash against the one in Postgres, an independent source.
 */
export async function verifyOnChainJoin(
  program: Program<RostrEscrow>,
  leagueId: string,
  expectedMember: PublicKey,
): Promise<JoinVerdict> {
  const league = leaguePda(leagueId);
  const address = membershipPda(league, expectedMember);

  const account = await program.account["membership"]?.fetchNullable(address);
  if (!account) return { ok: false, reason: "NOT_FOUND" };

  const raw = account as { league: PublicKey; member: PublicKey };

  return { ok: true, membership: { league: raw.league, member: raw.member } };
}

/**
 * The terms a league's *signed rules* say its on-chain account should hold.
 *
 * The caller builds this from the canonical rule set it already has, because the
 * escrow package does not depend on the rules schema. The payout ordering is
 * **not** the caller's to invent: apply `payoutArray()` from this package, which
 * is the one place `PRIZE_ORDER` is applied — serialising from the declaration
 * order of `PrizeKey` instead reshuffles the split with no error anywhere.
 *
 * Every field here is one the program stores independently of `rules_hash`.
 *
 * The six money fields are compared only for a pot league; a free league carries
 * zeroes and defaults for all of them.
 */
export interface ExpectedTerms {
  readonly hasPot: boolean;
  readonly maxTeams: number;
  /** Base units as a decimal string. */
  readonly buyIn: string;
  /** Unix seconds, as a decimal string — see `OnChainLeague.refundUnlockAt`. */
  readonly refundUnlockAt: string;
  readonly tokenMint: string;
  readonly feeBps: number;
  readonly feeRecipient: string;
  readonly payoutBps: readonly number[];
}

/**
 * The shape of a rule set this needs, and nothing more.
 *
 * Structural rather than an import of `LeagueRules`: the escrow package must not
 * depend on the rules schema, and a structural type keeps the mapping here — in
 * the fast test suite, next to `payoutArray` — instead of inline in a route that
 * nothing tests.
 */
export interface RulesLikeTerms {
  readonly league: { readonly maxTeams: number };
  readonly pot: {
    readonly tokenMint: string;
    readonly buyInBaseUnits: string;
    readonly refundUnlockAt: number;
    readonly feeBps: number;
    readonly feeRecipient: string;
    readonly payout: readonly { readonly prize: string; readonly basisPoints: number }[];
  } | null;
}

/**
 * What a league's signed rules say its account should hold.
 *
 * `pot == null` rather than `pot !== null` is deliberate: a stored document that
 * omits the key parses as `undefined`, and treating that as "has a pot" would
 * tell a genuine free league its rules imply one — a mismatch it could never
 * resolve, on the exact league shape this is meant to protect.
 */
export function expectedTermsFromRules(rules: RulesLikeTerms): ExpectedTerms {
  const pot = rules.pot;

  return {
    hasPot: pot !== null && pot !== undefined,
    maxTeams: rules.league.maxTeams,
    buyIn: pot?.buyInBaseUnits ?? "0",
    refundUnlockAt: String(pot?.refundUnlockAt ?? 0),
    tokenMint: pot?.tokenMint ?? "",
    feeBps: pot?.feeBps ?? 0,
    feeRecipient: pot?.feeRecipient ?? "",
    payoutBps: pot ? payoutArray(pot.payout) : [0, 0, 0, 0, 0],
  };
}

/**
 * The on-chain economic terms that disagree with the signed rules.
 *
 * Not necessarily *every* one: a pot-versus-free divergence is returned alone,
 * because the money fields of a free account are zeroes that would produce six
 * more lines all saying the same thing.
 *
 * `verifyLeagueAnchor` proves the chain holds *our hash*; it cannot prove the
 * chain holds *our terms*, because the program stores them as a separate copy it
 * has no way to check against the hash. So a creator can anchor the benign
 * document members sign while initialising the account with a hostile buy-in,
 * refund unlock, fee recipient or payout split — and members who verified only
 * the hash would deposit against terms they never agreed to. Closing that is the
 * caller's job: derive the expected terms from the same signed rules and assert
 * the account matches, refusing the anchor otherwise.
 *
 * Returns an empty array when everything agrees.
 */
export function anchorTermMismatches(
  onChain: OnChainLeague,
  expected: ExpectedTerms,
): string[] {
  const out: string[] = [];
  const ne = (label: string, got: unknown, want: unknown): void => {
    if (got !== want) out.push(`${label}: on-chain ${String(got)}, expected ${String(want)}`);
  };

  ne("hasPot", onChain.hasPot, expected.hasPot);
  ne("maxTeams", onChain.maxTeams, expected.maxTeams);

  // The money terms only mean anything for a pot league; a free one carries
  // zeroes/defaults for all of them, and the hasPot check above already caught a
  // pot-vs-free divergence.
  if (expected.hasPot && onChain.hasPot) {
    ne("buyIn", onChain.buyIn, expected.buyIn);
    ne("refundUnlockAt", onChain.refundUnlockAt, expected.refundUnlockAt);
    ne("tokenMint", onChain.tokenMint, expected.tokenMint);
    ne("feeBps", onChain.feeBps, expected.feeBps);

    // A recipient only means something when there is a fee to pay it. The
    // program itself requires one only when `fee_bps > 0`, so a fee-free league
    // legitimately carries a default or empty recipient — and `feeBps` is
    // compared just above, so a creator cannot use this to smuggle a fee in.
    //
    // Without this, a league created while `FEE_RECIPIENT` is unset stores
    // `feeRecipient: ""`, which no base58 key can equal. That is not a retry:
    // the PDA is one-shot, so a false mismatch here means the league can never
    // be anchored at all, only recreated under a new id.
    if (expected.feeBps > 0 || onChain.feeBps > 0) {
      ne("feeRecipient", onChain.feeRecipient, expected.feeRecipient);
    }

    if (
      onChain.payoutBps.length !== expected.payoutBps.length ||
      onChain.payoutBps.some((v, i) => v !== expected.payoutBps[i])
    ) {
      out.push(
        `payoutBps: on-chain [${onChain.payoutBps.join(",")}], ` +
          `expected [${expected.payoutBps.join(",")}]`,
      );
    }
  }

  return out;
}

/**
 * Which cluster an endpoint's *shape* suggests — a convenience for tests, and
 * **not** the authority.
 *
 * Use `resolveCluster` for anything that writes `leagues.chain_cluster` or
 * decides whether a signature counts. It asks the node for its genesis hash,
 * which is the chain's own identity; this only reads the URL, which is a label
 * somebody typed.
 *
 * **It no longer falls back to `mainnet-beta`, and that fallback was the bug.**
 * Any real deployment points at a private RPC, because the public nodes are
 * rate-limited and the order draw alone makes ~30 sequential calls — so a
 * perfectly ordinary devnet endpoint like `https://rostr.rpcpool.com/<key>`
 * matched none of the branches above and was recorded as mainnet. `0014` makes
 * that column write-once, `joinLeague` gates on it, and there is no correcting
 * row to write: a devnet league would have passed a mainnet join check forever.
 *
 * Guessing wrong here is unrecoverable and guessing right saves a caller one
 * line of configuration, so it throws.
 */
export function clusterOf(connection: Connection): string {
  const endpoint = connection.rpcEndpoint;
  if (endpoint.includes("devnet")) return "devnet";
  if (endpoint.includes("testnet")) return "testnet";
  if (endpoint.includes("mainnet")) return "mainnet-beta";
  if (endpoint.includes("localhost") || endpoint.includes("127.0.0.1")) return "localnet";

  throw new Error(
    `Cannot tell which cluster ${endpoint} is, and guessing would be recorded ` +
      `permanently. Set SOLANA_CLUSTER, or use resolveCluster() to ask the node.`,
  );
}

/** A member's on-chain stake state, as it exists on-chain. */
export interface OnChainMembership {
  readonly league: PublicKey;
  readonly member: PublicKey;
  /** Base units staked. Zero until `deposit`. */
  readonly deposited: bigint;
  readonly refunded: boolean;
  readonly bump: number;
}

/**
 * Read a member's `Membership` account, or `null` when it does not exist.
 *
 * Used by the deposit and refund verify routes: a stake can only move once the
 * member has joined on-chain (the `Membership` PDA exists), and the program's
 * deposit/refund instructions require that account — so the server checks it
 * here the same way the anchor and join routes check what they depend on.
 */
export async function readMembership(
  program: Program<RostrEscrow>,
  leagueId: string,
  member: PublicKey,
): Promise<OnChainMembership | null> {
  const league = leaguePda(leagueId);
  const address = membershipPda(league, member);

  const account = await program.account["membership"]?.fetchNullable(address);
  if (!account) return null;

  const raw = account as {
    league: PublicKey;
    member: PublicKey;
    deposited: { toString(): string };
    refunded: boolean;
    bump: number;
  };

  return {
    league: raw.league,
    member: raw.member,
    deposited: BigInt(raw.deposited.toString()),
    refunded: raw.refunded,
    bump: raw.bump,
  };
}

export type DepositVerdict =
  | { readonly ok: true; readonly deposited: bigint }
  | { readonly ok: false; readonly reason: "NOT_JOINED" }
  | { readonly ok: false; readonly reason: "NOT_DEPOSITED" }
  | { readonly ok: false; readonly reason: "ALREADY_REFUNDED" };

/**
 * Confirm a member's stake is **in the vault right now**.
 *
 * ## `deposited > 0` is not "currently staked"
 *
 * `refund_stake` sets `refunded = true` and **leaves `deposited` alone** — its
 * own comment calls it "the historical record". So a member who staked and then
 * withdrew after the timelock still reads `deposited > 0`, and a check on that
 * field alone records a live deposit for money that has left the vault.
 *
 * Both conditions are load-bearing and neither implies the other. See
 * `membership.test.ts` for the four reachable states written out.
 */
export async function verifyOnChainDeposit(
  program: Program<RostrEscrow>,
  leagueId: string,
  member: PublicKey,
): Promise<DepositVerdict> {
  const membership = await readMembership(program, leagueId, member);
  if (!membership) return { ok: false, reason: "NOT_JOINED" };

  // `NOT_DEPOSITED`, not `ALREADY_DEPOSITED`. Zero means the money is not in,
  // and telling somebody their buy-in is paid when it is not is the one thing a
  // money screen must never do.
  if (membership.deposited === 0n) return { ok: false, reason: "NOT_DEPOSITED" };
  if (membership.refunded) return { ok: false, reason: "ALREADY_REFUNDED" };

  return { ok: true, deposited: membership.deposited };
}

export type RefundVerdict =
  | { readonly ok: true; readonly refunded: bigint }
  | { readonly ok: false; readonly reason: "NOT_JOINED" }
  | { readonly ok: false; readonly reason: "NOTHING_DEPOSITED" }
  | { readonly ok: false; readonly reason: "NOT_REFUNDED" };

/**
 * Confirm a member **has** withdrawn their stake on-chain.
 *
 * ## This was inverted, and the inversion is worth spelling out
 *
 * `refund_stake` sets `refunded = true` and keeps `deposited` as history, so the
 * state a genuine refund leaves behind is `deposited > 0 && refunded`. That was
 * exactly the state this function rejected, as `ALREADY_REFUNDED` — so **no real
 * refund could ever be recorded** — while it answered `ok` for a member who had
 * staked and *not* refunded, whose money was still in the vault.
 *
 * Composed with a `walletAddress` taken from the request body, that second half
 * let any signed-in account mark any staked member as refunded. Both halves are
 * fixed; the wallet is now proved to belong to the session.
 *
 * The on-chain guarantee was never in question — no Rust was involved, and
 * `refund_stake` still needs the member's own signature. This is the *accounting*
 * disagreeing with the chain, which is its own kind of serious in a league where
 * the record is what people read.
 *
 * `refunded` rather than `deposited` on the success case, because the number
 * being reported is now an amount that came *back out*, and a caller storing it
 * under the wrong name is how this class of bug starts.
 */
export async function verifyOnChainRefund(
  program: Program<RostrEscrow>,
  leagueId: string,
  member: PublicKey,
): Promise<RefundVerdict> {
  const membership = await readMembership(program, leagueId, member);
  if (!membership) return { ok: false, reason: "NOT_JOINED" };
  if (membership.deposited === 0n) return { ok: false, reason: "NOTHING_DEPOSITED" };
  if (!membership.refunded) return { ok: false, reason: "NOT_REFUNDED" };

  return { ok: true, refunded: membership.deposited };
}
