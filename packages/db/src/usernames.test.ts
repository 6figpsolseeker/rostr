import { afterEach, describe, expect, it } from "vitest";
import { createUser, findUserByWallet, IdentityError, linkWallet } from "./identity.js";
import {
  findUserByUsername,
  setUsername,
  usernameAvailable,
  usernameProblem,
} from "./usernames.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function fresh(): Promise<PGliteClient> {
  db = await createTestDatabase();
  return db;
}

describe("usernameProblem", () => {
  it("accepts an ordinary name", () => {
    expect(usernameProblem("dakPrescott")).toBeNull();
    expect(usernameProblem("route_66")).toBeNull();
  });

  it("refuses one that is too short or too long", () => {
    expect(usernameProblem("ab")).toBe("TOO_SHORT");
    expect(usernameProblem("a".repeat(21))).toBe("TOO_LONG");
  });

  it("reports length before shape", () => {
    // Telling somebody who typed two characters about the permitted character
    // set answers a question they did not ask.
    expect(usernameProblem("!!")).toBe("TOO_SHORT");
  });

  it("refuses a name that is only digits", () => {
    // This repo already puts UUIDs in URLs. `12345` in an invite box should be
    // an error, not a lookup that mysteriously finds nobody.
    expect(usernameProblem("12345")).toBe("ALL_DIGITS");
  });

  it("requires a leading letter", () => {
    expect(usernameProblem("_leading")).toBe("BAD_SHAPE");
    expect(usernameProblem("1player")).toBe("BAD_SHAPE");
  });

  it("refuses spaces, punctuation and anything exotic", () => {
    expect(usernameProblem("two words")).toBe("BAD_SHAPE");
    expect(usernameProblem("dak.prescott")).toBe("BAD_SHAPE");
    expect(usernameProblem("dak-prescott")).toBe("BAD_SHAPE");
    expect(usernameProblem("dak@rostr")).toBe("BAD_SHAPE");
  });

  it("refuses reserved names, whatever the capitals", () => {
    // Two reasons, and both matter: a member called `rostr` or `support` is a
    // phishing attempt with no effort behind it, and these are path segments
    // the app already uses.
    expect(usernameProblem("rostr")).toBe("RESERVED");
    expect(usernameProblem("Support")).toBe("RESERVED");
    expect(usernameProblem("ADMIN")).toBe("RESERVED");
    expect(usernameProblem("leagues")).toBe("RESERVED");
  });

  it("trims before judging, so a stray space is not an error", () => {
    expect(usernameProblem("  dakPrescott  ")).toBeNull();
  });
});

describe("setUsername", () => {
  it("claims a name and hands back what was stored", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");

    expect(await setUsername(client, user.id, "  dakPrescott ")).toBe("dakPrescott");

    const found = await findUserByUsername(client, "dakPrescott");
    expect(found).toMatchObject({ id: user.id, username: "dakPrescott" });
  });

  it("preserves the capitals somebody chose", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");
    await setUsername(client, user.id, "DakPrescott");

    const [row] = await client.query<{ username: string }>(
      "SELECT username FROM users WHERE id = $1",
      [user.id],
    );
    expect(row?.username).toBe("DakPrescott");
  });

  it("refuses a name another account already holds, ignoring case", async () => {
    // The whole point of a username is that a commissioner can type what they
    // were told. `dakPrescott` and `dakprescott` must not be two people.
    const client = await fresh();
    const first = await createUser(client, "a@example.test", "A");
    const second = await createUser(client, "b@example.test", "B");

    await setUsername(client, first.id, "dakPrescott");
    await expect(setUsername(client, second.id, "DAKPRESCOTT")).rejects.toMatchObject({
      code: "USERNAME_TAKEN",
    });
  });

  it("lets you re-capitalise your own name", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");
    await setUsername(client, user.id, "dakprescott");

    expect(await setUsername(client, user.id, "dakPrescott")).toBe("dakPrescott");
  });

  it("refuses an invalid name before it reaches the database", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");

    await expect(setUsername(client, user.id, "no")).rejects.toBeInstanceOf(IdentityError);
    await expect(setUsername(client, user.id, "rostr")).rejects.toMatchObject({
      code: "INVALID_USERNAME",
    });
  });

  it("cannot be talked past the database's own shape check", async () => {
    // The CHECK constraint in `0035` is a floor under the validator, not a
    // duplicate of it: a future caller writing straight SQL must not be able to
    // leave a row the application would have refused to create.
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");

    await expect(
      client.query("UPDATE users SET username = $2 WHERE id = $1", [user.id, "two words"]),
    ).rejects.toThrow();
  });

  it("changing a name frees the old one", async () => {
    const client = await fresh();
    const first = await createUser(client, "a@example.test", "A");
    const second = await createUser(client, "b@example.test", "B");

    await setUsername(client, first.id, "route66");
    await setUsername(client, first.id, "route67");

    expect(await setUsername(client, second.id, "route66")).toBe("route66");
  });
});

describe("findUserByUsername", () => {
  it("is case-insensitive, because a person repeated the name", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");
    await setUsername(client, user.id, "RouteSixtySix");

    expect(await findUserByUsername(client, "routesixtysix")).toMatchObject({ id: user.id });
  });

  it("answers null for nobody, and for an empty box", async () => {
    const client = await fresh();
    expect(await findUserByUsername(client, "ghost")).toBeNull();
    expect(await findUserByUsername(client, "   ")).toBeNull();
  });
});

describe("usernameAvailable", () => {
  it("is false for a taken name and true for a free one", async () => {
    const client = await fresh();
    const first = await createUser(client, "a@example.test", "A");
    const second = await createUser(client, "b@example.test", "B");
    await setUsername(client, first.id, "taken_name");

    expect(await usernameAvailable(client, second.id, "taken_name")).toBe(false);
    expect(await usernameAvailable(client, second.id, "free_name")).toBe(true);
  });

  it("is true for your own name, so a form does not call you a duplicate", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");
    await setUsername(client, user.id, "mine_already");

    expect(await usernameAvailable(client, user.id, "mine_already")).toBe(true);
  });

  it("is false for a name that is invalid rather than taken", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");
    expect(await usernameAvailable(client, user.id, "no")).toBe(false);
  });
});

describe("findUserByWallet", () => {
  const ADDRESS = "8FE27ioQh3T7o22QsYVT5Re8NnHFqmFNbdqwiF3ywuZQ";

  it("finds the account that proved it holds an address", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");
    await linkWallet(client, user.id, ADDRESS);
    await client.query("UPDATE wallets SET verified_at = now() WHERE address = $1", [ADDRESS]);

    expect(await findUserByWallet(client, ADDRESS)).toMatchObject({ id: user.id });
  });

  it("ignores a wallet that was never verified", async () => {
    // Being reachable at an address you never proved you hold is the part worth
    // being strict about — an invitation sent there names the wrong person.
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");
    await linkWallet(client, user.id, ADDRESS);

    expect(await findUserByWallet(client, ADDRESS)).toBeNull();
  });

  it("does not match on case, because base58 is case-sensitive", async () => {
    // Two addresses differing only in case are two different keys. Lowercasing
    // here would be a way to invite somebody other than the person meant.
    const client = await fresh();
    const user = await createUser(client, "a@example.test", "A");
    await linkWallet(client, user.id, ADDRESS);
    await client.query("UPDATE wallets SET verified_at = now() WHERE address = $1", [ADDRESS]);

    expect(await findUserByWallet(client, ADDRESS.toLowerCase())).toBeNull();
  });
});
