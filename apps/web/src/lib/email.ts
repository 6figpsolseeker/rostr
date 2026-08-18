import "server-only";

/**
 * Sending the sign-in link.
 *
 * No provider is configured yet — see `docs/SETUP-REQUIRED.md`. Until one is,
 * this logs the link to the server console in development so the flow is fully
 * usable locally, and **fails loudly in production** rather than pretending to
 * have sent something. A sign-in that silently goes nowhere looks like a broken
 * account, and the user has no way to tell the difference.
 */

export interface DeliveryResult {
  readonly delivered: boolean;
  /**
   * The link, returned only when there is no provider **and** we are not in
   * production, so the developer can click it.
   *
   * Never in production: handing a sign-in link back over the same HTTP response
   * would let anyone who can hit the endpoint sign in as any email they name.
   */
  readonly devLink?: string;
}

/**
 * The provider was asked to send and refused.
 *
 * Separate from {@link EmailNotConfiguredError} because the two need different
 * answers: that one is a deployment that was never finished, this one is a
 * working deployment whose provider said no — a suppressed address, an
 * exhausted quota, a sender the account is not permitted to use, or the
 * provider being down.
 *
 * It is **expected**, not exceptional. The commonest cause in practice is a
 * shared test sender, which only delivers to the account owner, so every other
 * address fails here. Letting it escape as an unhandled throw produced a 500
 * with an empty body, and the browser then showed the user a JSON parse error
 * instead of anything about email.
 */
export class EmailDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(
      "The email provider refused to send the sign-in link. That is a delivery " +
        "problem rather than a problem with the address.",
    );
    this.name = "EmailDeliveryError";
  }
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      "No email provider is configured, so the sign-in link cannot be sent. " +
        "Set RESEND_API_KEY and EMAIL_FROM — see docs/SETUP-REQUIRED.md.",
    );
    this.name = "EmailNotConfiguredError";
  }
}

export async function sendSignInLink(email: string, link: string): Promise<DeliveryResult> {
  const apiKey = process.env["RESEND_API_KEY"];
  const from = process.env["EMAIL_FROM"];

  if (!apiKey || !from) {
    if (process.env.NODE_ENV === "production") throw new EmailNotConfiguredError();

    // eslint-disable-next-line no-console
    console.info(`\n  Sign-in link for ${email}:\n  ${link}\n`);
    return { delivered: false, devLink: link };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Your rostr sign-in link",
      text: [
        "Sign in to rostr:",
        "",
        link,
        "",
        "The link works once and expires in 24 hours.",
        "If you did not ask for this, ignore it — nothing has changed.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    // Typed, so the route can answer with a readable JSON body. This used to be
    // a bare `Error`, which the route rethrew — and an unhandled throw in a
    // route handler is a 500 with no body at all. The client then parses that
    // body as JSON and shows the user the parse failure.
    throw new EmailDeliveryError(response.status, await response.text());
  }

  return { delivered: true };
}
