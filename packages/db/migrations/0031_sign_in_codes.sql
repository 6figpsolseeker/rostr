-- Signing in with a code that is typed, rather than a link that is followed.
--
-- ## Why the link had to go
--
-- A sign-in link is a GET that consumes a single-use credential, so anything
-- that *visits* it spends it — and plenty of things visit a URL without a person
-- deciding to. Observed in one evening on a live deployment, three separate
-- ways:
--
--   1. Chrome's Safe Browsing interstitial. The request reached the server, the
--      token was consumed and a session created, and the browser then discarded
--      the response — including its `Set-Cookie` — to paint a warning. Clicking
--      through re-requested a URL whose token was already gone. Three sessions
--      were created that no browser ever held.
--   2. A mail client's in-app browser, which has its own cookie jar, so the
--      session landed somewhere the real browser could not see.
--   3. Two links in one inbox: issuing the second superseded the first, and the
--      first is the one nearer the top.
--
-- None of those is a bug in the link. They are consequences of putting a
-- credential in a URL and asking a mail client to handle it.
--
-- A code is typed into a page the person already has open. Nothing prefetches
-- it, no interstitial can eat it, and the session is created in the browser that
-- asked for it. It also makes signing in independent of the domain's reputation,
-- which matters while a Safe Browsing flag is outstanding.
--
-- ## What a short code costs, and how it is paid for
--
-- The old credential was `randomBytes(32)` — 2^256 possibilities, where guessing
-- is not a threat model. Six digits is 1,000,000, and guessing becomes the
-- threat model. Three things pay for that, and removing any one reopens it:
--
--   * `attempts`, here. The code is destroyed after MAX_CODE_ATTEMPTS wrong
--     guesses, so an attacker gets a handful of tries per issued code rather
--     than unlimited tries.
--   * A ten-minute expiry rather than twenty-four hours, in `identity.ts`,
--     which bounds the window in which any guessing is possible at all.
--   * A per-address attempt limit in the rate limiter, so an attacker cannot
--     simply request a fresh code each time they exhaust one.
--
-- The counter lives on the row rather than in the limiter because it must be
-- bound to *this* code: a new code deserves a fresh count, and the row is
-- deleted and rewritten on issue.
--
-- `token_hash` keeps its name and its meaning — the SHA-256 of the credential,
-- never the credential. A database leak still hands over nothing usable, which
-- is why the column is not widened or re-typed for a six-character value.

ALTER TABLE email_verification_tokens
  ADD COLUMN attempts smallint NOT NULL DEFAULT 0;

COMMENT ON COLUMN email_verification_tokens.attempts IS
  'Wrong guesses against this code. The row is deleted once it reaches the '
  'limit in identity.ts, so a six-digit code cannot be brute-forced: an '
  'attacker gets a few tries per issued code, not unlimited tries.';

COMMENT ON TABLE email_verification_tokens IS
  'One outstanding sign-in credential per user, stored as a SHA-256 hash. Since '
  'migration 0031 the credential is a short numeric code that is typed, not a '
  'token embedded in a link that is followed — see the migration for why.';
