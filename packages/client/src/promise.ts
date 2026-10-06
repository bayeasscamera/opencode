// Promise/legacy client entrypoint.
//
// The app and session-ui still consume the published promise surface
// (`@opencode-ai/client/promise`). Sourcing it from the repository package
// instead of a vendored tarball keeps it in lockstep with the generated client.
export * from "./index"

/**
 * @deprecated Legacy diff shape from the published promise client.
 * Retained byte-for-byte until the app and session-ui move to the current
 * Protocol diff contracts (see packages/app/V1_API_MIGRATION.md).
 */
export type FileDiffInfo = {
  readonly file: string
  readonly patch: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}
