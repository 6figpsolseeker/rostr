/**
 * What a joining member's one transaction should contain, and which halves of it
 * the server should then be asked to record.
 *
 * ## Why this is a function and not four booleans in a component
 *
 * `apps/web` cannot render a component in a test — both vitest projects are
 * node-environment with no jsdom — so a decision taken inline in `JoinPanel` is
 * verified only by being run in production. This is the decision, lifted out
 * whole: `lib/pot.ts`, `lib/lobby.ts` and `expectedTermsFromRules` are the
 * pattern.
 *
 * ## The send and the record are one decision, not two
 *
 * That is the whole reason both live here. `JoinPanel` used to decide what to
 * *send* from one expression and what to *POST* from another, and issue #168 is
 * what happens when the two drift: the stake was omitted and `/deposit` was
 * posted anyway, so `verifyOnChainDeposit` answered `NOT_DEPOSITED`, the route
 * 409'd, the retry re-posted the same thing, and a member whose join had
 * succeeded was told forever that it had failed.
 *
 * A verifier that reads the chain cannot be argued with. So the rule here is:
 * **never ask the server to confirm something this transaction did not do and
 * the chain does not already say.**
 */

/** A member's `Membership` account, as far as this decision cares. */
export interface MembershipState {
  /** Base units the program has ever accepted from this member. */
  readonly deposited: bigint;
  /** Whether that stake has since been withdrawn. */
  readonly refunded: boolean;
}

export interface JoinPlanInput {
  /** `null` when no `Membership` account exists yet. */
  readonly membership: MembershipState | null;
  /** Whether the league plays for a pot at all. */
  readonly hasPot: boolean;
  /**
   * Whether this deployment should invite a buy-in — `potDepositGate`, read
   * through `depositsOpen()` on the server and passed down.
   *
   * **Separate from `hasPot`, and they must not be collapsed.** A free league
   * and a pot league whose staking is deferred are different sentences on the
   * screen, and only one of them ever gets a stake later.
   */
  readonly depositsOpen: boolean;
}

export interface JoinPlan {
  /** Add `join_league` to the transaction. */
  readonly sendJoin: boolean;
  /** Add `deposit` to the same transaction. */
  readonly sendStake: boolean;
  /**
   * POST `/deposit` after it lands.
   *
   * True when this transaction stakes, and also when the chain already holds a
   * live stake whose record never made it — the retry case. False in every
   * state where `verifyOnChainDeposit` would refuse, because a POST it refuses
   * is not a failed record, it is a member permanently told their join broke.
   */
  readonly recordStake: boolean;
  /**
   * Nothing is owed on-chain, so a previous attempt landed and its POST did
   * not. The caller recovers the creating signature rather than signing again —
   * `join_league` uses `init` and cannot run twice.
   */
  readonly nothingToSend: boolean;
}

/**
 * Decide it once, for both the transaction and the records.
 *
 * ## `deposited > 0` answers two different questions
 *
 * **"Has this member ever staked?"** decides what the *program* will accept:
 * `deposit` refuses a second stake, so sending one to a member who has ever
 * staked fails the whole transaction — taking the join with it when they are
 * batched.
 *
 * **"Is this member staked right now?"** decides what the *verifier* will
 * accept: `refund_stake` leaves `deposited` in place as the historical record
 * and sets `refunded`, so a member who took their money back reads `deposited >
 * 0` and `verifyOnChainDeposit` answers `ALREADY_REFUNDED`.
 *
 * Conflating them gives a refunded member a POST that can never succeed and a
 * retry button that re-sends it — reachable today, and the reason `recordStake`
 * is derived from *currently* staked rather than from *ever* staked.
 */
export function joinPlan(input: JoinPlanInput): JoinPlan {
  const membership = input.membership;
  const everStaked = membership !== null && membership.deposited > 0n;
  const currentlyStaked =
    membership !== null && membership.deposited > 0n && !membership.refunded;

  // A stake is invited only when there is a pot *and* this deployment is willing
  // to take one. The gate is why a member can legitimately hold a seat with
  // nothing staked, which is exactly the state `DepositPanel` exists to finish.
  const sendStake = input.hasPot && input.depositsOpen && !everStaked;
  const sendJoin = input.membership === null;

  return {
    sendJoin,
    sendStake,
    // Moves with `sendStake`, never with `hasPot`. The `|| currentlyStaked` half
    // is the retry: the money is in the vault and only the record is missing, so
    // the verifier will confirm it and the POST is worth making.
    recordStake: sendStake || currentlyStaked,
    nothingToSend: !sendJoin && !sendStake,
  };
}
