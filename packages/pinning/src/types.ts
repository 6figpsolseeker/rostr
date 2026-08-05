/**
 * Content pinning.
 *
 * A league's rules are hashed on-chain; the document those bytes came from lives
 * off-chain and has to stay retrievable, or the hash anchors nothing and the
 * whole immutability story reduces to "trust us".
 *
 * Behind an interface from the first commit: pinning services change, and the
 * rest of the codebase must never learn which one is behind this.
 */

export interface PinResult {
  /** Content identifier from the pinning service. */
  readonly cid: string;
  /** Retrievable URI, e.g. `ipfs://bafy...`. Stored as `leagues.rules_uri`. */
  readonly uri: string;
}

export interface PinningService {
  /**
   * Pin raw bytes.
   *
   * Implementations MUST store the content byte-for-byte. Anything that parses
   * and re-serialises will change the bytes and therefore the hash, which
   * defeats the point.
   */
  pin(content: string, name: string): Promise<PinResult>;

  /** Retrieve previously pinned content by URI or CID. */
  fetch(uriOrCid: string): Promise<string>;
}

export class PinningError extends Error {
  constructor(message: string, cause?: unknown) {
    // Pass through to the standard `cause` rather than shadowing it, so
    // `console.error` and structured loggers show the underlying failure.
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PinningError";
  }
}

/**
 * Content was pinned, but reading it back produced different bytes.
 *
 * Treated as fatal rather than retried: a `rules_uri` that resolves to anything
 * other than the exact hashed document is worse than no URI at all, because it
 * looks verified.
 */
export class PinVerificationError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
    readonly uri: string,
  ) {
    super(
      `Pinned content at ${uri} does not match what was pinned ` +
        `(expected ${expectedHash}, got ${actualHash})`,
    );
    this.name = "PinVerificationError";
  }
}
