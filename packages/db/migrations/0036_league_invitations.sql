-- Being asked to a league.
--
-- Private leagues are the default and are unlisted by design, so until now the
-- only invitation was a URL sent through some other channel — which works, and
-- leaves the invitee with nothing to come back to if they lose the message, and
-- the commissioner with no idea who they have already asked.
--
-- **An invitation is an address, not an entitlement.** It records that somebody
-- was asked. It grants nothing: joining still runs every check it always did —
-- the league must be anchored and FORMING, the field open, a seat free, and the
-- member signs the rules hash from their own wallet. Nothing in `joinLeague`
-- reads this table, and nothing should. That is what keeps an invitation from
-- becoming a second, weaker way in.
--
-- **Acceptance is derived, never stored.** There is no `accepted_at` column,
-- because `league_memberships` already answers it: a member is a member because
-- they signed the rules hash, and a row here saying "accepted" would be a second
-- account of the same fact, free to disagree with the first. The same reasoning
-- the bracket follows in refusing to store who advanced.
--
-- Withdrawal *is* stored, because nothing else records it — a withdrawn
-- invitation is not the absence of one, and a commissioner who takes an
-- invitation back should not see it reappear as "never asked".

CREATE TABLE league_invitations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, like every other reference into `leagues`. A league is never
  -- deleted; the state machine's DISSOLVED is how one ends.
  league_id          uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  -- Resolved from whatever the commissioner typed — a username or a wallet
  -- address — at the moment the invitation is written. Storing the *person*
  -- rather than the string is what lets somebody rename themselves afterwards
  -- without an invitation quietly pointing at nobody, or at the next person to
  -- take that name.
  invited_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  invited_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Which of the two the commissioner actually typed. Kept so the invitation can
  -- be shown the way it was sent: "invited by username" and "invited by wallet
  -- address" are different assurances to the person receiving it.
  addressed_as       text NOT NULL CHECK (addressed_as IN ('USERNAME', 'WALLET')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  withdrawn_at       timestamptz,
  -- One invitation per person per league. A commissioner inviting somebody twice
  -- is re-sending, not queueing a second ask — the route upserts onto this.
  UNIQUE (league_id, invited_user_id)
);

-- The invitee's own list: "what am I invited to". Ordered by recency at the
-- application layer; this index is what stops that being a scan of every
-- invitation in the system.
CREATE INDEX league_invitations_invitee_idx
  ON league_invitations (invited_user_id, created_at DESC);
