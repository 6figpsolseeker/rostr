/**
 * In-memory pinning, for tests and local development.
 *
 * Content-addressed like the real thing: the CID is derived from the bytes, so
 * pinning identical content twice yields one entry, and a CID cannot be
 * requested for content that was never pinned.
 */

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { PinningError } from "./types.js";
import type { PinningService, PinResult } from "./types.js";

export class InMemoryPinningService implements PinningService {
  private readonly store = new Map<string, string>();

  /** Fails the next `pin()` call. For exercising error paths in tests. */
  failNextPin = false;

  pin(content: string, _name: string): Promise<PinResult> {
    if (this.failNextPin) {
      this.failNextPin = false;
      return Promise.reject(new PinningError("Simulated pinning failure"));
    }

    const cid = bytesToHex(sha256(new TextEncoder().encode(content)));
    this.store.set(cid, content);
    return Promise.resolve({ cid, uri: `memory://${cid}` });
  }

  fetch(uriOrCid: string): Promise<string> {
    const cid = uriOrCid.replace(/^memory:\/\//, "");
    const content = this.store.get(cid);
    if (content === undefined) {
      return Promise.reject(new PinningError(`Nothing pinned at ${uriOrCid}`));
    }
    return Promise.resolve(content);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
