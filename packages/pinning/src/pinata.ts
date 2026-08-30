/**
 * Pinata.
 *
 * One thing here is load-bearing and easy to get wrong: this uses
 * `pinFileToIPFS`, **not** `pinJSONToIPFS`.
 *
 * Our canonical rule document happens to be valid JSON, so the JSON endpoint
 * looks like the natural fit. It is not. That endpoint parses the payload and
 * re-serialises it on Pinata's side — reordering keys, changing whitespace, or
 * reformatting numbers. Any of those changes the bytes, and changed bytes mean a
 * different hash from the one members signed.
 *
 * Uploading the exact string as a file preserves it byte-for-byte.
 */

import { PinningError } from "./types.js";
import type { PinningService, PinResult } from "./types.js";

const PIN_ENDPOINT = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const DEFAULT_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

export interface PinataOptions {
  readonly jwt: string;
  /** Gateway used by `fetch()`. Must end with a slash. */
  readonly gateway?: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

interface PinataResponse {
  IpfsHash: string;
}

export class PinataPinningService implements PinningService {
  private readonly jwt: string;
  private readonly gateway: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: PinataOptions) {
    if (!options.jwt) throw new PinningError("Pinata JWT is required");
    this.jwt = options.jwt;
    this.gateway = options.gateway ?? DEFAULT_GATEWAY;
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async pin(content: string, name: string): Promise<PinResult> {
    const form = new FormData();
    // Byte-exact upload. See the note at the top of this file.
    form.append("file", new Blob([content], { type: "application/json" }), name);
    form.append("pinataMetadata", JSON.stringify({ name }));

    /*
      Pin at CIDv0 explicitly, because the URI it produces is written once.

      A CID is a function of the bytes, so re-pinning the same rules gives back
      the same address and a retry is a no-op — that is what lets `setRulesUri`
      treat an identical URI as success and what makes `0044`'s set-once rule
      safe. But CIDv0 `Qm…` and CIDv1 `bafy…` are two encodings of the same
      multihash, and which one comes back is an **account setting** on Pinata's
      side, not a property of the bytes. Left to the default, a change nobody
      here made would produce a different string for identical rules — the retry
      clause would miss, and the league, already pinned, could only be corrected
      by a migration.

      `0044` states that the format is fixed at write time. This is where.
    */
    form.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));

    let response: Response;
    try {
      response = await this.doFetch(PIN_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.jwt}` },
        body: form,
      });
    } catch (error) {
      throw new PinningError("Pinata request failed", error);
    }

    if (!response.ok) {
      // Truncated: this is a third party's response body going into an exception
      // whose message reaches a server log. The status and the first line are
      // what anyone diagnoses from; the rest is unbounded text we do not control.
      const detail = await response.text().catch(() => "");
      throw new PinningError(`Pinata returned ${response.status}: ${detail.slice(0, 500)}`);
    }

    const body = (await response.json()) as PinataResponse;
    if (!body.IpfsHash) throw new PinningError("Pinata response had no IpfsHash");

    return { cid: body.IpfsHash, uri: `ipfs://${body.IpfsHash}` };
  }

  async fetch(uriOrCid: string): Promise<string> {
    const cid = uriOrCid.replace(/^ipfs:\/\//, "");
    const url = `${this.gateway}${cid}`;

    let response: Response;
    try {
      response = await this.doFetch(url);
    } catch (error) {
      throw new PinningError(`Failed to fetch ${url}`, error);
    }

    if (!response.ok) {
      throw new PinningError(`Gateway returned ${response.status} for ${url}`);
    }
    return response.text();
  }
}
