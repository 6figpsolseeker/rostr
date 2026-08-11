# Migrations

Forward-only, plain SQL, applied in ascending version order. There are no down
migrations: a league's rules are immutable and its history must stay auditable,
so the answer to a bad migration is another migration.

Two rules the runner enforces, and one it cannot:

- **An applied file may never be edited.** The runner checksums each one and
  refuses to start if a recorded file has changed.
- **A new file may never sort below one already applied.** Added because the
  checksum rule was only half of "forward-only": nothing stopped `0014` being
  applied after `0015` in an environment that deployed `0015` first, building the
  schema in an order nobody tested.
- **Numbering is on you.** Two branches can pick the same number, and this repo
  is developed on two machines plus an occasional fork — so it has already
  happened three times in a single day.

## Numbering

Take the next number **above main's highest**, and **renumber on rebase if main
moved**. Never merge a PR whose migration number is at or below main's head.

The collision fails loudly rather than silently — `loadMigrations` throws
`Duplicate migration version N` and every database-backed test in the repo fails
— so you will not ship one by accident. You will just have to fix it.

## When `db:migrate` refuses

### "…is older than the latest applied version"

A migration numbered below one already applied. What to do depends on a question
the error cannot answer: **has this branch's migration already run on this
database?**

1. **It has not** — the normal case, and what the refusal exists to guarantee.
   `git mv` the file to the next free number above the reported version, rebase,
   re-run. Safe, and nothing else is needed.

2. **It has, on this machine, under the old number.** Renumbering makes the file
   look new, so it re-runs its DDL and dies on `relation ... already exists`. The
   error will not tell you that is what happened.

   On a **local development database**, drop it and start again:

   ```
   pnpm db:migrate   # after recreating the database
   pnpm db:seed
   ```

   Cheap, always correct, and the reason a dev database should stay disposable.

3. **On a shared or production database**, do not hand-edit `schema_migrations`
   and do not renumber. Write a **new** forward migration, numbered above the
   head, that reaches the intended state idempotently (`IF NOT EXISTS`,
   `CREATE OR REPLACE`). The out-of-order file stays where it is; the new one
   corrects the result.

> The advice in the error message — "renumber it above N and rebase" — is case 1
> only. On a machine that already applied the file it makes things worse, which
> on a two-machine project is not a corner case.

### "…has changed since it was applied" when you did not change it

Almost certainly **two branches numbered the same version**, not an edited file.
The checksum check keys on version alone, so a different file at the same number
looks identical to an edit, and its advice — "add a new one instead of editing
this" — is useless here.

Confirm it:

```sql
SELECT version, name FROM schema_migrations ORDER BY version;
```

against `ls packages/db/migrations`. Same version, different `name` is a
collision. Then follow case 2 or 3 above.

### "Another migration run holds the lock on this database"

Two runs at once — a deploy and a hand-run, two machines, or a re-triggered CI
job. The runner takes a **session advisory lock** for the whole of its run and a
second run finds it taken and stops immediately rather than waiting.

Nothing is wrong and nothing is half-done. Wait for the other run and re-run:
applied migrations are skipped, so the second run costs one round trip if the
first one did everything.

It refuses rather than queueing on purpose. Waiting is how a deploy hangs, and
under the pool's `statement_timeout` the wait would be cut off anyway by an error
naming the timeout instead of the real cause.

**The lock only works on a session-mode connection.** `DATABASE_URL` must be the
Supabase _session_ pooler, as `.env.example` says. The transaction pooler returns
your connection to its own pool between transactions, so a session lock guards
nothing and is stranded on a backend you no longer hold.

The failure is in two parts and only the second is visible. The first run appears
to succeed, unguarded. The unlock then lands on a different backend, where
`pg_advisory_unlock` returns false with a WARNING rather than an error — so the
lock is never released. **Every later run refuses, blaming a concurrent run that
does not exist**, and the advice in the section above ("wait for it and re-run")
never comes true. If migrations start refusing on a database that has no other
deploy touching it, check the port before anything else.

## `db:status` and `db:migrate` can disagree

`db:status` lists a migration as `PENDING` if its version is absent from
`schema_migrations`. It does not apply the ordering rule, so a file the runner
will refuse still shows as pending. `db:status` tells you what is _missing_;
`db:migrate` decides what is _allowed_.

## Testing

Migrations run against PGlite — real Postgres compiled to WASM, in-process, no
service and no credentials. `createTestDatabase()` gives a fresh migrated
database per test, which is why every test file is free to write whatever it
likes.

One consequence worth knowing when writing a migration: **PGlite is a single
connection.** Anything whose correctness depends on two sessions interleaving —
row locks, `FOR UPDATE`, `ON CONFLICT` racing an insert — cannot be reproduced by
the test suite. Two real bugs have reached production code through that gap. If a
migration's correctness rests on locking behaviour, say so in its header and
verify it against a real Postgres before relying on it.

The **runner's** own connection behaviour is the one thing that gap has been
closed for, in `migrate.pool.test.ts`. It drives the real `pg-pool` with a stub
`Client` (`pg` accepts one through `options.Client`), so which connection each
statement lands on is decided by real pool code with no database underneath. That
technique covers dispatch and ordering only — it says nothing about whether a
transaction actually commits, which still needs PGlite or a real server.

Two things the runner does are therefore still unverified here and want a real
Postgres before anyone leans on them: that `SET LOCAL statement_timeout = 0` lets
a long `CREATE INDEX` run to completion, and that two separate processes racing
for the advisory lock resolve the way one process asking twice does.
