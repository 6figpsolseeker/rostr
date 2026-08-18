import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDeliveryError, EmailNotConfiguredError, sendSignInLink } from "./email.js";

/**
 * Sending the sign-in link, and — the point of this file — what happens when
 * the provider says no.
 *
 * A refusal is expected rather than exceptional: a suppressed address, an
 * exhausted quota, or a shared test sender that only delivers to the account
 * owner. It used to throw a bare `Error`, which the route rethrew, which made a
 * 500 with an empty body, which the browser tried to parse as JSON — so the
 * user was shown "Unexpected end of JSON input" for a mail problem. Every step
 * of that chain was reasonable on its own.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const configure = (): void => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "onboarding@resend.dev");
};

describe("sendSignInLink", () => {
  it("reports a provider refusal as EmailDeliveryError, not a bare Error", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("You can only send testing emails to your own address", { status: 403 }),
        ),
    );

    await expect(sendSignInLink("someone@example.com", "https://x/y")).rejects.toBeInstanceOf(
      EmailDeliveryError,
    );
  });

  it("carries the provider's status and detail for the server log", async () => {
    // Kept for the operator, deliberately not returned to the caller: the text
    // can name the recipient and the sending domain, and this endpoint answers
    // identically whether or not an account exists.
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("domain not verified", { status: 422 })),
    );

    const error = await sendSignInLink("a@b.com", "https://x/y").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).status).toBe(422);
    expect((error as EmailDeliveryError).detail).toContain("domain not verified");
  });

  it("says the address is not the problem, because it usually is not", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));

    const error = (await sendSignInLink("a@b.com", "https://x/y").catch(
      (e: unknown) => e,
    )) as Error;

    expect(error.message).toMatch(/delivery problem/i);
    expect(error.message).not.toMatch(/Unexpected end of JSON/);
  });

  it("reports success when the provider accepts", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "abc" }), { status: 200 })),
    );

    await expect(sendSignInLink("a@b.com", "https://x/y")).resolves.toEqual({
      delivered: true,
    });
  });

  it("is a different error when no provider is configured at all", async () => {
    // A deployment that was never finished, as against one whose provider
    // refused. The route answers 503 for the first and 502 for the second.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");

    await expect(sendSignInLink("a@b.com", "https://x/y")).rejects.toBeInstanceOf(
      EmailNotConfiguredError,
    );
  });

  it("hands the link back outside production when unconfigured, so local sign-in works", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");

    const result = await sendSignInLink("a@b.com", "https://x/y");

    expect(result.delivered).toBe(false);
    expect(result.devLink).toBe("https://x/y");
  });
});
