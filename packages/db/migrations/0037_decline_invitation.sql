-- An invitation can be refused.
--
-- `0036` stored withdrawal and not decline, so the only way out of an invitation
-- was for the commissioner to take it back. An invitee who was never going to
-- join carried it in their list indefinitely, and the commissioner had no way to
-- tell "has not looked yet" from "has decided against it" — which is exactly the
-- fact that tells them to invite somebody else.
--
-- Separate from `withdrawn_at`, not a shared "cancelled_at". They are different
-- acts by different people and the commissioner's screen has to distinguish
-- them: an invitation you withdrew is one you may want to re-send, and one that
-- was declined is one you probably should not. Collapsing them would make the
-- invite panel unable to say which happened, and there is no second place that
-- records it.
ALTER TABLE league_invitations
  ADD COLUMN declined_at timestamptz;

-- Both cannot be true at once. They are mutually exclusive events — a
-- commissioner cannot withdraw an invitation that has already been refused and
-- an invitee cannot refuse one that is no longer offered — and the routes each
-- check for the other. This is what makes that a fact rather than a convention
-- two call sites happen to keep.
ALTER TABLE league_invitations
  ADD CONSTRAINT league_invitations_one_ending
  CHECK (withdrawn_at IS NULL OR declined_at IS NULL);
