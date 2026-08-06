-- Rate limiting.
--
-- In Postgres rather than in memory, because the web app runs as serverless
-- functions: an in-process counter would be per-instance, and an attacker gets
-- a fresh allowance every time the platform spins up another one.
--
-- ## Token bucket, not fixed windows
--
-- A fixed window ("5 per hour, reset on the hour") lets someone spend the whole
-- allowance at 10:59 and the whole next one at 11:01 — double the intended rate,
-- right at the boundary, which is exactly where a script lands.
--
-- A token bucket refills continuously, so the rate holds across every boundary,
-- and it needs one row per subject rather than one per window.
--
-- ## Integer micro-tokens
--
-- Same reasoning as milli-points elsewhere: no floats. A bucket is 1,000,000
-- micro-tokens per whole request, which leaves room to express slow refill rates
-- exactly rather than rounding them to nothing.

CREATE TABLE rate_limits (
  -- What is being limited, e.g. 'auth:request:email'.
  bucket        text NOT NULL,
  -- Who. An email, a user ID, or a *hashed* IP — see `hashedIp` in the app.
  subject       text NOT NULL,
  micro_tokens  bigint NOT NULL,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (bucket, subject)
);

CREATE INDEX rate_limits_stale_idx ON rate_limits (updated_at);

/**
 * Take one token, or report how long until one is available.
 *
 * Atomic: the row is locked for the read-modify-write, so two requests arriving
 * together cannot both see the last token.
 */
CREATE FUNCTION consume_rate_limit(
  p_bucket    text,
  p_subject   text,
  p_capacity  bigint,   -- micro-tokens; whole requests * 1,000,000
  p_window_ms bigint,   -- time to refill from empty to full
  p_now       timestamptz
) RETURNS TABLE (allowed boolean, micro_remaining bigint, retry_after_ms bigint) AS $$
DECLARE
  v_tokens     bigint;
  v_elapsed_ms bigint;
BEGIN
  IF p_capacity <= 0 OR p_window_ms <= 0 THEN
    RAISE EXCEPTION 'capacity and window must both be positive (got %, %)',
      p_capacity, p_window_ms;
  END IF;

  SELECT micro_tokens,
         GREATEST(0, (EXTRACT(EPOCH FROM (p_now - updated_at)) * 1000)::bigint)
    INTO v_tokens, v_elapsed_ms
    FROM rate_limits
   WHERE bucket = p_bucket AND subject = p_subject
     FOR UPDATE;

  IF NOT FOUND THEN
    -- A subject seen for the first time starts full.
    v_tokens := p_capacity;
  ELSE
    v_tokens := LEAST(p_capacity, v_tokens + (p_capacity * v_elapsed_ms) / p_window_ms);
  END IF;

  IF v_tokens >= 1000000 THEN
    v_tokens := v_tokens - 1000000;
    allowed := true;
    retry_after_ms := 0;
  ELSE
    allowed := false;
    -- When one whole token will have accrued. Refusals are cheap, so this is
    -- reported rather than left for the caller to guess at.
    retry_after_ms := CEIL(((1000000 - v_tokens)::numeric * p_window_ms) / p_capacity)::bigint;
  END IF;

  -- The bucket is written on refusal too. Otherwise `updated_at` would stop
  -- moving under sustained load and the refill maths would keep re-crediting
  -- the same elapsed time.
  INSERT INTO rate_limits (bucket, subject, micro_tokens, updated_at)
  VALUES (p_bucket, p_subject, v_tokens, p_now)
  ON CONFLICT (bucket, subject)
  DO UPDATE SET micro_tokens = EXCLUDED.micro_tokens, updated_at = EXCLUDED.updated_at;

  micro_remaining := v_tokens;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
