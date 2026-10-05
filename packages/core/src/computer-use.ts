export * as ComputerUse from "./computer-use"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs"

const execAsync = promisify(exec)

/**
 * The desktop this process is attached to. Every screen capture and every synthetic keystroke goes
 * through here, which is what makes computer use injectable: a Session can be handed a controller
 * that has no way to reach the real desktop, and tests always are. `computer.ts` owns the policy
 * (permission, background-worker confinement); this service owns the mechanism.
 */
export class Failure extends Schema.TaggedErrorClass<Failure>()("ComputerUse.Failure", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Captures the screen to `dest`, failing when the capture produced no file. */
  readonly screenshot: (dest: string) => Effect.Effect<void, Failure>
  /** Types `text` into whatever currently has focus. */
  readonly keystroke: (text: string) => Effect.Effect<void, Failure>
  /** Presses `key` with `modifiers` held down. */
  readonly keyCombo: (key: string, modifiers: ReadonlyArray<string>) => Effect.Effect<void, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ComputerUse") {}

const attempt = (command: string) =>
  Effect.tryPromise({
    try: () => execAsync(command),
    catch: (error) => new Failure({ message: error instanceof Error ? error.message : String(error) }),
  }).pipe(Effect.asVoid)

/** AppleScript is the only input backend, and it only exists on macOS. */
const unsupported = new Failure({ message: "réservé à macOS via AppleScript" })

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const isMac = process.platform === "darwin"

    return Service.of({
      screenshot: (dest) => {
        const command = isMac
          ? `screencapture -x "${dest}"`
          : `scrot "${dest}" 2>/dev/null || import -window root "${dest}"`
        return attempt(command).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              fs.existsSync(dest) ? Effect.void : Effect.fail(new Failure({ message: "aucun fichier produit" })),
            ),
          ),
        )
      },
      keystroke: (text) =>
        isMac
          ? attempt(`osascript -e 'tell application "System Events" to keystroke "${text.replace(/"/g, '\\"')}"'`)
          : Effect.fail(unsupported),
      keyCombo: (key, modifiers) => {
        if (!isMac) return Effect.fail(unsupported)
        const held = modifiers.map((modifier) => `${modifier} down`).join(", ")
        const clause = held ? ` using {${held}}` : ""
        return attempt(`osascript -e 'tell application "System Events" to key code "${key}"${clause}'`)
      },
    })
  }),
)

export const node = makeLocationNode({ name: "computer-use", layer, deps: [] })
