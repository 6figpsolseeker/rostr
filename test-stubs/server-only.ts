/**
 * A stand-in for Next's `server-only` marker, for the test runner.
 *
 * `import "server-only"` is a build-time assertion, not a runtime import: Next's
 * bundler resolves it to a module that throws if it is ever pulled into a client
 * bundle, which is how `db.ts`, `session.ts` and the rest guarantee they never
 * reach a browser. Outside Next there is nothing to resolve — the package is not
 * even a declared dependency, it arrives transitively — so vitest cannot load
 * any file that imports it.
 *
 * Stubbed rather than removed from those files. The marker is doing real work in
 * the build; it is only the test runner that has no bundler to satisfy it, and
 * weakening a production guarantee to make a test run is the wrong direction.
 *
 * Deliberately empty. Anything here would be pretending to be a bundler.
 */

export {};
