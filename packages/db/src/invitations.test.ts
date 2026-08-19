import { afterEach, describe, expect, it } from "vitest";
import { buildNflPprRules, NFL } from "@rostr/core";
import type { DraftRules, LeagueRules } from "@rostr/core";
import { createUser, linkWallet } from "./identity.js";
import {
  invitationsForLeague,
  invitationsForUser,
  inviteToLeague,
  withdrawInvitation,
} from "./invitations.js";
import { createLeague } from "./leagues.js";
import { seedSport } from "./sports.js";
import { setUsername } from "./usernames.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

const DRAFT: DraftRules = {
  type: "SNAKE",
  mode: "SLOW",
  pickSeconds: 14_400,
  scheduledAt: 1_756_400_000,
};

/** A forming league, the way every other suite here builds one. */
async function makeLeague(
  client: PGliteClient,
  commissionerId: string,
  name: string,
): Promise<string> {
  const league = await createLeague(client, NFL, {
    name,
    commissionerId,
    rules: buildNflPprRules({ seasonYear: 2026, draft: DRAFT }) as LeagueRules,
  });
  return league.id;
}

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const ADDRESS = "8FE27ioQh3T7o22QsYVT5Re8NnHFqmFNbdqwiF3ywuZQ";

interface Fixture {
  client: PGliteClient;
  leagueId: string;
  commissioner: string;
  invitee: string;
}

/** A forming league, its commissioner, and somebody to ask. */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();
  await seedSport(db, NFL);

  const commissioner = await createUser(db, "commish@example.test", "Commish");
  const invitee = await createUser(db, "friend@example.test", "Friend");
  await setUsername(db, invitee.id, "route66");

  const leagueId = await makeLeague(db, commissioner.id, "Dynasty of Dropped Passes");

  return { client: db, leagueId, commissioner: commissioner.id, invitee: invitee.id };
}

describe("inviteToLeague", () => {
  it("invites by username, case-insensitively", async () => {
    const fx = await setup();
    const invitation = await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "ROUTE66",
    });

    expect(invitation).toMatchObject({
      invitedUserId: fx.invitee,
      addressedAs: "USERNAME",
      accepted: false,
    });
  });

  it("invites by wallet address, and records which was used", async () => {
    // The two are different assurances to the person receiving it, so the
    // invitation is shown the way it was sent.
    const fx = await setup();
    await linkWallet(fx.client, fx.invitee, ADDRESS);
    await fx.client.query("UPDATE wallets SET verified_at = now() WHERE address = $1", [
      ADDRESS,
    ]);

    const invitation = await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: ADDRESS,
    });

    expect(invitation).toMatchObject({ invitedUserId: fx.invitee, addressedAs: "WALLET" });
  });

  it("tells an unknown username from an unknown address", async () => {
    // A username cannot look like an address — names cap at 20 characters and
    // the shortest address is 32 — so what was typed decides which lookup runs,
    // and the message names the thing they actually typed.
    const fx = await setup();

    await expect(
      inviteToLeague(fx.client, {
        leagueId: fx.leagueId,
        invitedBy: fx.commissioner,
        identifier: "nobody_here",
      }),
    ).rejects.toMatchObject({ code: "NO_SUCH_USER", message: /username/ });

    await expect(
      inviteToLeague(fx.client, {
        leagueId: fx.leagueId,
        invitedBy: fx.commissioner,
        identifier: ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "NO_SUCH_USER", message: /wallet/ });
  });

  it("refuses an address nobody has verified", async () => {
    const fx = await setup();
    await linkWallet(fx.client, fx.invitee, ADDRESS);

    await expect(
      inviteToLeague(fx.client, {
        leagueId: fx.leagueId,
        invitedBy: fx.commissioner,
        identifier: ADDRESS,
      }),
    ).rejects.toMatchObject({ code: "NO_SUCH_USER" });
  });

  it("refuses an empty box rather than looking nobody up", async () => {
    const fx = await setup();
    await expect(
      inviteToLeague(fx.client, {
        leagueId: fx.leagueId,
        invitedBy: fx.commissioner,
        identifier: "   ",
      }),
    ).rejects.toMatchObject({ code: "EMPTY" });
  });

  it("refuses to invite yourself", async () => {
    const fx = await setup();
    await setUsername(fx.client, fx.commissioner, "the_boss");

    await expect(
      inviteToLeague(fx.client, {
        leagueId: fx.leagueId,
        invitedBy: fx.commissioner,
        identifier: "the_boss",
      }),
    ).rejects.toMatchObject({ code: "SELF" });
  });

  it("re-inviting is a re-send, not a second invitation", async () => {
    const fx = await setup();
    await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });
    await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });

    expect(await invitationsForLeague(fx.client, fx.leagueId)).toHaveLength(1);
  });

  it("re-inviting revives one that was withdrawn", async () => {
    // Otherwise a commissioner who changed their mind can never change it back,
    // with nothing on screen explaining why.
    const fx = await setup();
    const first = await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });
    await withdrawInvitation(fx.client, fx.leagueId, first.id);
    expect(await invitationsForUser(fx.client, fx.invitee)).toHaveLength(0);

    await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });
    expect(await invitationsForUser(fx.client, fx.invitee)).toHaveLength(1);
  });

  it("refuses a league that is no longer forming", async () => {
    // The cost of a stale invitation lands on the invitee: they arrive, read the
    // whole rule set, and find the door shut. Better to refuse the commissioner.
    const fx = await setup();
    await fx.client.query("UPDATE leagues SET state = 'DRAFTING' WHERE id = $1", [fx.leagueId]);

    await expect(
      inviteToLeague(fx.client, {
        leagueId: fx.leagueId,
        invitedBy: fx.commissioner,
        identifier: "route66",
      }),
    ).rejects.toMatchObject({ code: "LEAGUE_CLOSED" });
  });

  it("refuses a league that does not exist", async () => {
    const fx = await setup();
    await expect(
      inviteToLeague(fx.client, {
        leagueId: "00000000-0000-0000-0000-000000000000",
        invitedBy: fx.commissioner,
        identifier: "route66",
      }),
    ).rejects.toMatchObject({ code: "LEAGUE_NOT_FOUND" });
  });
});

describe("withdrawInvitation", () => {
  it("takes one back, and says nothing on a second attempt", async () => {
    const fx = await setup();
    const invitation = await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });

    await withdrawInvitation(fx.client, fx.leagueId, invitation.id);
    await withdrawInvitation(fx.client, fx.leagueId, invitation.id);

    const [row] = await invitationsForLeague(fx.client, fx.leagueId);
    expect(row?.withdrawnAt).not.toBeNull();
  });

  it("cannot reach an invitation belonging to another league", async () => {
    // The route establishes that the caller runs *this* league; the league id in
    // the statement is what ties that to the row being changed. Without it, a
    // commissioner of any league could withdraw any invitation by guessing a
    // UUID — the same scoping `vetoTrade` uses.
    const fx = await setup();
    const otherLeagueId = await makeLeague(fx.client, fx.commissioner, "Elsewhere");
    const invitation = await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });

    await withdrawInvitation(fx.client, otherLeagueId, invitation.id);

    const [row] = await invitationsForLeague(fx.client, fx.leagueId);
    expect(row?.withdrawnAt).toBeNull();
  });
});

describe("invitationsForUser", () => {
  it("lists what you have been asked to and not joined", async () => {
    const fx = await setup();
    await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });

    const mine = await invitationsForUser(fx.client, fx.invitee);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ leagueId: fx.leagueId, addressedAs: "USERNAME" });
  });

  it("shows nothing to somebody who was not asked", async () => {
    const fx = await setup();
    await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });

    expect(await invitationsForUser(fx.client, fx.commissioner)).toHaveLength(0);
  });

  it("drops out once the league is no longer forming", async () => {
    const fx = await setup();
    await inviteToLeague(fx.client, {
      leagueId: fx.leagueId,
      invitedBy: fx.commissioner,
      identifier: "route66",
    });
    await fx.client.query("UPDATE leagues SET state = 'DRAFTING' WHERE id = $1", [fx.leagueId]);

    expect(await invitationsForUser(fx.client, fx.invitee)).toHaveLength(0);
  });
});
