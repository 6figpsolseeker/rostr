-- Close a cold-start bypass in consume_rate_limit.
--
-- The original locked the bucket row with SELECT ... FOR UPDATE *before* the row
-- existed, and only created it at the end via INSERT ... ON CONFLICT. A
-- FOR UPDATE against a row that is not there yet locks nothing — Postgres has no
-- predicate locks — so concurrent first-touch calls all took the NOT FOUND
-- branch, all saw a full bucket, and all passed. The limit did not apply to a
-- subject's opening burst, and because purgeIdleRateLimits deletes idle buckets,
-- a subject returned to that cold state on a cadence, making the bypass
-- repeatable.
--
-- The fix materialises the row (INSERT ... ON CONFLICT DO NOTHING) before locking
-- it, so the row always exists and FOR UPDATE genuinely serialises concurrent
-- callers. Sequential behaviour is unchanged: a first-time subject still starts
-- full and the token-bucket maths is identical.

CREATE OR REPLACE FUNCTION consume_rate_limit(
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

  -- Make the bucket exist before locking it. A first-touch subject starts full;
  -- an existing one is left untouched here and read below. This is what lets the
  -- FOR UPDATE that follows actually serialise concurrent callers — a lock on a
  -- row that does not yet exist is a lock on nothing.
  INSERT INTO rate_limits (bucket, subject, micro_tokens, updated_at)
  VALUES (p_bucket, p_subject, p_capacity, p_now)
  ON CONFLICT (bucket, subject) DO NOTHING;

  SELECT micro_tokens,
         GREATEST(0, (EXTRACT(EPOCH FROM (p_now - updated_at)) * 1000)::bigint)
    INTO v_tokens, v_elapsed_ms
    FROM rate_limits
   WHERE bucket = p_bucket AND subject = p_subject
     FOR UPDATE;

  v_tokens := LEAST(p_capacity, v_tokens + (p_capacity * v_elapsed_ms) / p_window_ms);

  IF v_tokens >= 1000000 THEN
    v_tokens := v_tokens - 1000000;
    allowed := true;
    retry_after_ms := 0;
  ELSE
    allowed := false;
    -- When one whole token will have accrued.
    retry_after_ms := CEIL(((1000000 - v_tokens)::numeric * p_window_ms) / p_capacity)::bigint;
  END IF;

  -- Written on refusal too, so `updated_at` keeps moving under sustained load and
  -- the refill maths does not keep re-crediting the same elapsed time.
  --
  -- An upsert rather than a plain UPDATE, and that is load-bearing. The INSERT
  -- above takes **no lock** when the row already exists — ON CONFLICT DO NOTHING
  -- does not lock the conflicting row — so `purgeIdleRateLimits` can delete it
  -- between that INSERT and the FOR UPDATE below. In that window the SELECT finds
  -- nothing, `v_tokens` is NULL, and `LEAST(p_capacity, NULL)` returns
  -- **p_capacity** rather than NULL, because LEAST skips NULLs. The call is then
  -- allowed against a notionally full bucket, and a plain UPDATE would match zero
  -- rows — dropping the charge and leaving the row absent, so the next caller
  -- starts full again too.
  --
  -- The version this replaced handled that explicitly with an IF NOT FOUND branch
  -- that recreated the row. Removing the branch made the behaviour depend on an
  -- accident of LEAST's NULL semantics. This restores the guarantee without the
  -- branch: it recreates a vanished row and is identical to an UPDATE otherwise.
  INSERT INTO rate_limits (bucket, subject, micro_tokens, updated_at)
  VALUES (p_bucket, p_subject, v_tokens, p_now)
  ON CONFLICT (bucket, subject)
  DO UPDATE SET micro_tokens = EXCLUDED.micro_tokens, updated_at = EXCLUDED.updated_at;

  micro_remaining := v_tokens;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
