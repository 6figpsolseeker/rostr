/**
 * A request body as an object, or `{}` when it is not one.
 *
 * `request.json()` throws on malformed JSON, and a valid body of `null` parses
 * fine and then throws on the first field read. Either way the route answered
 * 500 for the caller's mistake. Answering `{}` sends both to the handler's own
 * required-field check, which says 400.
 */
export async function jsonBody(request: Request): Promise<object> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null ? body : {};
}
