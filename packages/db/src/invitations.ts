/**
 * Invitations — being asked to a league.
 *
 * **An invitation grants nothing.** It records that somebody was asked, and that
 * is all. `joinLeague` does not read this table and must not start: joining
 * still requires an anchored league in FORMING, an open field, a free seat, and
 * a signature over the rules hash from the member's own wallet. An invitation
 * that let somebody past any of those would be a second, weaker way in, and the
 * weaker way is the one an attacker would use.
 *
 * What it buys is discovery. Private leagues are unlisted by design, so before
 * this the only invitation was a URL sent through some other channel — which
 * leaves the invitee nothing to come back to if they lose the message, and the
 * commissioner no record of who they already asked.
 */

import type { SqlClient } from "./client.js";
import { findUserByWallet } from "./identity.js";
import { findUserByUsername } from "./usernames.js";

export class InvitationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NO_SUCH_USER"
      | "ALREADY_A_MEMBER"
      | "SELF"
      | "LEAGUE_NOT_FOUND"
      | "LEAGUE_CLOSED"
      | "EMPTY",
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

/** How the commissioner addressed it. Kept so it can be shown as it was sent. */
export type AddressedAs = "USERNAME" | "WALLET";

export interface Invitation {
  readonly id: string;
  readonly leagueId: string;
  readonly leagueName: string;
  readonly invitedUserId: string;
  readonly addressedAs: AddressedAs;
  readonly createdAt: Date;
  readonly withdrawnAt: Date | null;
  /**
   * When the invitee refused, if they did.
   *
   * Distinct from `withdrawnAt` because the commissioner's next move differs:
   * an invitation they withdrew is one they may want to re-send, and one that
   * was declined is one they probably should not. A shared "cancelled" would
   * leave the panel unable to say which happened, and nothing else records it.
   */
  readonly declinedAt: Date | null;
  /**
   * Whether the invitee has since joined.
   *
   * **Derived from `league_memberships`, never stored.** A member is a member
   * because they signed the rules hash; a column here saying "accepted" would be
   * a second account of that fact, free to disagree with the first.
   */
  readonly accepted: boolean;
}

/**
 * A base58 Solana address is 32–44 characters and excludes `0`, `O`, `I`, `l`.
 *
 * Used only to decide **which lookup to run** on what somebody typed, never to
 * validate. A string that looks like an address but is not simply finds nobody,
 * which is the same answer an unknown username gets.
 */
const LOOKS_LIKE_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Invite somebody, by username or by wallet address.
 *
 * One box, two kinds of answer, and the shape of what was typed decides which —
 * because asking a commissioner to first classify what they are pasting is a
 * question with an obvious answer that only they can get wrong. A username
 * cannot look like an address: `usernameProblem` caps names at 20 characters
 * and the shortest address is 32.
 *
 * Re-inviting somebody already invited is an **upsert**, not an error. Pressing
 * the button twice is re-sending, which is what a person means by it.
 */
export async function inviteToLeague(
  db: SqlClient,
  input: {
    readonly leagueId: string;
    readonly invitedBy: string;
    /** Whatever the commissioner typed. */
    readonly identifier: string;
  },
): Promise<Invitation> {
  const identifier = input.identifier.trim();
  if (identifier === "") {
    throw new InvitationError("Type a username or a wallet address", "EMPTY");
  }

  const [league] = await db.query<{ name: string; state: string }>(
    "SELECT name, state FROM leagues WHERE id = $1",
    [input.leagueId],
  );
  if (!league) throw new InvitationError("League not found", "LEAGUE_NOT_FOUND");

  // Only a forming league can take anyone, so inviting to any other state is
  // asking somebody to a door that is already shut. Checked here rather than
  // left to `joinLeague` because the cost lands on the *invitee* otherwise —
  // they arrive, read the rules, and find they cannot join.
  if (league.state !== "FORMING") {
    throw new InvitationError("This league is no longer taking members", "LEAGUE_CLOSED");
  }

  const addressedAs: AddressedAs = LOOKS_LIKE_ADDRESS.test(identifier) ? "WALLET" : "USERNAME";

  const invitee =
    addressedAs === "WALLET"
      ? await findUserByWallet(db, identifier)
      : await findUserByUsername(db, identifier);

  if (!invitee) {
    throw new InvitationError(
      addressedAs === "WALLET"
        ? "No account has verified that wallet address"
        : "No account with that username",
      "NO_SUCH_USER",
    );
  }

  if (invitee.id === input.invitedBy) {
    throw new InvitationError("You cannot invite yourself", "SELF");
  }

  const [member] = await db.query<{ user_id: string }>(
    "SELECT user_id FROM league_memberships WHERE league_id = $1 AND user_id = $2",
    [input.leagueId, invitee.id],
  );
  if (member) {
    throw new InvitationError("They are already in this league", "ALREADY_A_MEMBER");
  }

  const [row] = await db.query<{ id: string; created_at: string; addressed_as: string }>(
    `INSERT INTO league_invitations (league_id, invited_user_id, invited_by_user_id, addressed_as)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (league_id, invited_user_id) DO UPDATE
       SET addressed_as = EXCLUDED.addressed_as,
           invited_by_user_id = EXCLUDED.invited_by_user_id,
           created_at = now(),
           -- Re-inviting revives a withdrawn invitation. The alternative is a
           -- commissioner who changed their mind being permanently unable to
           -- change it back, with nothing on screen explaining why.
           withdrawn_at = NULL,
           -- And a declined one, deliberately, though it is the less obvious
           -- half. "We spoke and they changed their mind" is the ordinary
           -- reason a commissioner re-sends after a decline, and a permanent
           -- block would have no way to express it.
           --
           -- The cost is that a decline can be overridden by asking again, so
           -- it does not *bar* anyone. What it does is remove the invitation
           -- from the invitee's list and tell the commissioner they were
           -- refused — and each fresh decline is recorded in turn. Barring
           -- would need a separate opt-out belonging to the invitee rather
           -- than to one invitation; nothing here is that, and this comment is
           -- not claiming it is.
           declined_at = NULL
     RETURNING id, created_at, addressed_as`,
    [input.leagueId, invitee.id, input.invitedBy, addressedAs],
  );

  return {
    id: row!.id,
    leagueId: input.leagueId,
    leagueName: league.name,
    invitedUserId: invitee.id,
    addressedAs: row!.addressed_as as AddressedAs,
    createdAt: new Date(row!.created_at),
    withdrawnAt: null,
    declinedAt: null,
    accepted: false,
  };
}

/** Take an invitation back. Idempotent — withdrawing twice is not an error. */
export async function withdrawInvitation(
  db: SqlClient,
  leagueId: string,
  invitationId: string,
): Promise<void> {
  // Scoped by league as well as by id, so a commissioner of one league cannot
  // withdraw an invitation belonging to another by guessing a UUID. The route
  // has already established they run *this* league; this is what ties the two
  // together. Same shape as `vetoTrade`'s league scoping.
  await db.query(
    `UPDATE league_invitations SET withdrawn_at = now()
      WHERE id = $1 AND league_id = $2 AND withdrawn_at IS NULL`,
    [invitationId, leagueId],
  );
}

/**
 * Refuse an invitation.
 *
 * **Scoped by the invitee, never by the league**, which is the mirror image of
 * `withdrawInvitation` and the reason the two cannot share an implementation.
 * A commissioner acts on invitations belonging to their league; an invitee acts
 * on invitations belonging to *them*. Taking a league id here would let a
 * caller decline on somebody else's behalf by naming a league they happen to
 * run, and taking neither would let anyone decline anything with a UUID.
 *
 * The wallet-derivation rule elsewhere in this repo is the same idea: a caller
 * with no way to *name* another person has no way to act as them.
 *
 * Idempotent. A second decline matches no row and is not an error — the invitee
 * pressed a button twice, and telling them it failed would suggest they are
 * still invited.
 *
 * `withdrawn_at IS NULL` is not merely tidiness. Declining an invitation the
 * commissioner already took back would write a state the `0037` check
 * constraint refuses, and the honest answer is that there is nothing left to
 * decline.
 */
export async function declineInvitation(
  db: SqlClient,
  invitationId: string,
  invitedUserId: string,
): Promise<{ declined: boolean }> {
  const rows = await db.query<{ id: string }>(
    `UPDATE league_invitations SET declined_at = now()
      WHERE id = $1 AND invited_user_id = $2
        AND declined_at IS NULL AND withdrawn_at IS NULL
      RETURNING id`,
    [invitationId, invitedUserId],
  );

  return { declined: rows.length > 0 };
}

/** Everyone this league has asked, newest first. */
export async function invitationsForLeague(
  db: SqlClient,
  leagueId: string,
): Promise<readonly (Invitation & { invitedUsername: string | null })[]> {
  const rows = await db.query<{
    id: string;
    league_id: string;
    league_name: string;
    invited_user_id: string;
    invited_username: string | null;
    addressed_as: string;
    created_at: string;
    withdrawn_at: string | null;
    declined_at: string | null;
    accepted: boolean;
  }>(
    `SELECT i.id, i.league_id, l.name AS league_name, i.invited_user_id,
            u.username AS invited_username, i.addressed_as, i.created_at, i.withdrawn_at,
            i.declined_at,
            EXISTS (
              SELECT 1 FROM league_memberships m
               WHERE m.league_id = i.league_id AND m.user_id = i.invited_user_id
            ) AS accepted
       FROM league_invitations i
       JOIN leagues l ON l.id = i.league_id
       JOIN users u ON u.id = i.invited_user_id
      WHERE i.league_id = $1
      ORDER BY i.created_at DESC`,
    [leagueId],
  );

  return rows.map((row) => ({ ...toInvitation(row), invitedUsername: row.invited_username }));
}

/**
 * Leagues this person has been asked to and has not joined.
 *
 * Withdrawn and already-accepted invitations are filtered out here rather than
 * shown greyed: this list is a to-do, and an invitation you have acted on or
 * that was taken back is not something to do. The league itself is where a
 * member goes afterwards.
 *
 * Also filtered to leagues still FORMING, for the reason `inviteToLeague`
 * refuses to write one: an invitation to a league that has since drafted is an
 * invitation to a door that shut, and offering it costs the invitee a click and
 * a puzzled read of the rules.
 */
export async function invitationsForUser(
  db: SqlClient,
  userId: string,
): Promise<readonly Invitation[]> {
  const rows = await db.query<{
    id: string;
    league_id: string;
    league_name: string;
    invited_user_id: string;
    addressed_as: string;
    created_at: string;
    withdrawn_at: string | null;
    accepted: boolean;
  }>(
    `SELECT i.id, i.league_id, l.name AS league_name, i.invited_user_id,
            i.addressed_as, i.created_at, i.withdrawn_at, false AS accepted
       FROM league_invitations i
       JOIN leagues l ON l.id = i.league_id
      WHERE i.invited_user_id = $1
        AND i.withdrawn_at IS NULL
        -- Declined is an answer, and this list is a to-do. Leaving it here would
        -- make the button do nothing visible, which reads as a broken control
        -- rather than a recorded decision.
        AND i.declined_at IS NULL
        AND l.state = 'FORMING'
        AND NOT EXISTS (
          SELECT 1 FROM league_memberships m
           WHERE m.league_id = i.league_id AND m.user_id = i.invited_user_id
        )
      ORDER BY i.created_at DESC`,
    [userId],
  );

  return rows.map(toInvitation);
}

function toInvitation(row: {
  id: string;
  league_id: string;
  league_name: string;
  invited_user_id: string;
  addressed_as: string;
  created_at: string;
  withdrawn_at: string | null;
  declined_at?: string | null;
  accepted: boolean;
}): Invitation {
  return {
    id: row.id,
    leagueId: row.league_id,
    leagueName: row.league_name,
    invitedUserId: row.invited_user_id,
    addressedAs: row.addressed_as as AddressedAs,
    createdAt: new Date(row.created_at),
    withdrawnAt: row.withdrawn_at ? new Date(row.withdrawn_at) : null,
    declinedAt: row.declined_at ? new Date(row.declined_at) : null,
    accepted: row.accepted,
  };
}
