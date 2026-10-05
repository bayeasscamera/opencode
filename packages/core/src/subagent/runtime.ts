export * as SubagentRuntime from "./runtime"

import type { SessionV2 } from "../session"

/**
 * Process-wide accessor for the built `SessionV2` service.
 *
 * A Location-scoped layer node cannot depend on `SessionV2.node`: `SessionV2` pulls in the
 * unbound `SessionExecution` and `LocationServiceMap` globals, and `buildLocationServiceMap`
 * compiles the hoisted global tree without replacements, so the location build fails with
 * `Unbound layer node: @opencode/v2/SessionExecution`. There is also a genuine circular layer
 * dependency (SessionV2 needs LocationServiceMap; a location layer needing SessionV2 would need
 * the map to provide itself).
 *
 * The server therefore publishes the single built `SessionV2` instance here, and the subagent
 * tool reads it at execution time. This is deliberately one narrow module: it is the only
 * location-to-global escape hatch, and it holds no state beyond the service reference.
 */
let current: SessionV2.Interface | undefined

export const set = (sessions: SessionV2.Interface) => {
  current = sessions
}

export const sessions = (): SessionV2.Interface | undefined => current

/** Clears the published instance. Used by tests that assert the unavailable-runtime path. */
export const reset = () => {
  current = undefined
}
