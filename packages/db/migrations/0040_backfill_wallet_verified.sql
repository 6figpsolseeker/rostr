-- Record the verification that already happened.
--
-- `wallets.verified_at` was read by `findUserByWallet` and written by nothing,
-- so every row in every deployment is NULL. The column was added with the table
-- and the write was simply never wired: `linkWalletWithSignature` verifies a
-- signature over a server-issued nonce and then called `linkWallet`, whose
-- INSERT omitted it.
--
-- The consequence was silent and total. `findUserByWallet` requires the column,
-- so it matched nobody — inviting somebody by wallet address answered "no such
-- user" for every address including correct ones, and wallet sign-in refuses
-- every wallet with WALLET_NOT_LINKED.
--
-- **Backfilling is recording a fact, not asserting a new one.** Verified on
-- 2026-08-23 by enumerating every caller: `linkWalletWithSignature` is the only
-- thing in the repo that creates a `wallets` row, and it refuses without a valid
-- ed25519 signature over a nonce this server issued minutes earlier. There is no
-- path — no admin form, no import, no seed — by which an address somebody merely
-- typed could be in this table. Every existing row was proven; the proof was
-- discarded.
--
-- `created_at` rather than `now()`, because the wallet was proven when it was
-- linked and not when this migration ran. A timestamp saying otherwise would be
-- this migration inventing history to tidy its own arrival.
UPDATE wallets
   SET verified_at = created_at
 WHERE verified_at IS NULL;

-- Deliberately **not** a NOT NULL constraint.
--
-- Unverified is a state the schema should keep being able to express: it is what
-- an address linked by some future path that has not proved anything would look
-- like, and `findUserByWallet` excluding it is the check that would stop such a
-- path silently making addresses claimable. Making the column mandatory now
-- would force that future path to lie.
