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
    throw new Error(`Email provider returned ${response.status}: ${await response.text()}`);
  }

  return { delivered: true };
}
