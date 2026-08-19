import { NextResponse } from "next/server";
import {
  IdentityError,
  setUsername,
  usernameAvailable,
  USERNAME_CHECK_PER_IP,
  USERNAME_SET_PER_USER,
} from "@rostr/db";
import { db } from "@/lib/db";
import { byIp, enforceRateLimit } from "@/lib/rate-limit";
import { currentUser } from "@/lib/session";

const STATUS: Record<string, number> = {
  INVALID_USERNAME: 422,
  USERNAME_TAKEN: 409,
};

/**
 * Is this name free?
 *
 * Answers as somebody types, so the form can say "taken" before they commit to
 * it rather than after. **Advisory only** — two people typing the same name at
 * the same moment both get `true`, and the write below is what actually
 * decides. A check that pretended to reserve a name would be a way to hold one
 * without claiming it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const name = new URL(request.url).searchParams.get("name") ?? "";

  const limited = await enforceRateLimit([byIp(USERNAME_CHECK_PER_IP, request)]);
  if (limited) return limited;

  return NextResponse.json({ available: await usernameAvailable(db(), user.id, name) });
}

/**
 * Claim or change your username.
 *
 * The account comes from the session cookie and never from the body. A route
 * that took a user id would let anyone rename anyone — and since a username is
 * what a commissioner types to invite somebody, renaming a stranger is a way to
 * intercept an invitation meant for them.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { username?: string };
  if (typeof body.username !== "string") {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }

  const limited = await enforceRateLimit([{ rule: USERNAME_SET_PER_USER, subject: user.id }]);
  if (limited) return limited;

  try {
    const username = await setUsername(db(), user.id, body.username);
    return NextResponse.json({ username });
  } catch (error) {
    if (error instanceof IdentityError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS[error.code] ?? 400 },
      );
    }
    throw error;
  }
}
