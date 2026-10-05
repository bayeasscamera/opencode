export * as SubagentRuntime from "./runtime"

import { Context, Effect, Layer } from "effect"
// Value import: `publishing` needs the `SessionV2.Service` tag, not just its types. The tag is only
// dereferenced when a server layer is built, so this does not run at module evaluation time.
import { SessionV2 } from "../session"

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

/**
 * Wraps a server layer so that building it publishes its `SessionV2` instance here.
 *
 * Every process that serves Sessions must call this exactly once, on the layer that owns
 * `SessionV2.node`. Two servers build their own `SessionV2` today — `@opencode-ai/opencode`
 * (the desktop sidecar entrypoint) and `@opencode-ai/server` (the `opencode serve` CLI and the
 * daemon the TUI spawns) — and both must publish, or the subagent tool answers "moteur de
 * session non disponible" in that process.
 */
export const publishing = <A, E, R>(layer: Layer.Layer<SessionV2.Service | A, E, R>) =>
  layer.pipe(Layer.tap((context) => Effect.sync(() => set(Context.get(context, SessionV2.Service)))))
