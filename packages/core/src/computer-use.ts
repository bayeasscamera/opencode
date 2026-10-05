export * as ComputerUse from "./computer-use"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { execFile } from "child_process"
import { promisify } from "util"
import fs from "fs"

const execFileAsync = promisify(execFile)

/**
 * The desktop this process is attached to. Every screen capture and every synthetic keystroke goes
 * through here, which is what makes computer use injectable: a Session can be handed a controller
 * that has no way to reach the real desktop, and tests always are. `computer.ts` owns the policy
 * (permission, background-worker confinement); this service owns the mechanism.
 *
 * Nothing here builds a shell string. Every program is launched with an argument array, so a file
 * name or a typed sentence can never be read as a second command.
 */
export class Failure extends Schema.TaggedErrorClass<Failure>()("ComputerUse.Failure", {
  message: Schema.String,
}) {}

/** The only modifiers AppleScript accepts in a `using {...}` clause. */
export const MODIFIERS = ["command", "shift", "option", "control"] as const

/** Named keys and the macOS virtual key code each one presses. */
export const NAMED_KEYS: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
}

/**
 * Runs one program with an argument array. Injectable so a test can observe exactly what would have
 * been launched without ever reaching the real desktop.
 */
export type Runner = (file: string, args: ReadonlyArray<string>) => Promise<void>

export interface Command {
  readonly file: string
  readonly args: ReadonlyArray<string>
}

/**
 * Escapes text for an AppleScript string literal. The backslash goes first on purpose: escaping the
 * quote first would turn `"` into `\"`, and the backslash pass would then double the backslash it
 * had just introduced, letting the quote escape again. Line breaks are escaped as well, because a
 * raw one cannot appear inside a literal at all.
 */
export const escapeAppleScript = (text: string) =>
  text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")

export const screenshotCommand = (platform: NodeJS.Platform, dest: string): Command =>
  platform === "darwin" ? { file: "screencapture", args: ["-x", dest] } : { file: "scrot", args: [dest] }

export const keystrokeCommand = (text: string): Command => ({
  file: "osascript",
  args: ["-e", `tell application "System Events" to keystroke "${escapeAppleScript(text)}"`],
})

export const keyComboCommand = (key: number, modifiers: ReadonlyArray<string>): Command => {
  const held = modifiers.map((modifier) => `${modifier} down`).join(", ")
  const clause = held ? ` using {${held}}` : ""
  return { file: "osascript", args: ["-e", `tell application "System Events" to key code ${key}${clause}`] }
}

/** A key is either a bare virtual key code or one of the names in `NAMED_KEYS`. */
export const resolveKey = (key: string): number | undefined =>
  /^\d{1,3}$/.test(key) ? Number(key) : NAMED_KEYS[key.trim().toLowerCase()]

/** Every modifier has to be known, so an unknown one is refused rather than pasted into the script. */
export const resolveModifiers = (modifiers: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  const normalized = modifiers.map((modifier) => modifier.trim().toLowerCase())
  const known: ReadonlyArray<string> = MODIFIERS
  return normalized.every((modifier) => known.includes(modifier)) ? normalized : undefined
}

export interface Interface {
  /** Captures the screen to `dest`, failing when the capture produced no file. */
  readonly screenshot: (dest: string) => Effect.Effect<void, Failure>
  /** Types `text` into whatever currently has focus. */
  readonly keystroke: (text: string) => Effect.Effect<void, Failure>
  /** Presses `key` with `modifiers` held down. */
  readonly keyCombo: (key: string, modifiers: ReadonlyArray<string>) => Effect.Effect<void, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ComputerUse") {}

export interface Dependencies {
  readonly run: Runner
  readonly platform: NodeJS.Platform
}

const invoke = (run: Runner, command: Command) =>
  Effect.tryPromise({
    try: () => run(command.file, command.args),
    catch: (error) => new Failure({ message: error instanceof Error ? error.message : String(error) }),
  })

/** AppleScript is the only input backend, and it only exists on macOS. */
const unsupported = new Failure({ message: "réservé à macOS via AppleScript" })

export const make = ({ run, platform }: Dependencies): Interface => ({
  screenshot: (dest) => {
    // `scrot` has no fallback chain once there is no shell to interpret `||`, so the Linux fallback
    // is a second launch rather than a second command in one string.
    const capture =
      platform === "darwin"
        ? invoke(run, screenshotCommand(platform, dest))
        : invoke(run, screenshotCommand(platform, dest)).pipe(
            Effect.catchTag("ComputerUse.Failure", () => invoke(run, { file: "import", args: ["-window", "root", dest] })),
          )
    return capture.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          fs.existsSync(dest) ? Effect.void : Effect.fail(new Failure({ message: "aucun fichier produit" })),
        ),
      ),
    )
  },
  keystroke: (text) => (platform === "darwin" ? invoke(run, keystrokeCommand(text)) : Effect.fail(unsupported)),
  keyCombo: (key, modifiers) => {
    if (platform !== "darwin") return Effect.fail(unsupported)
    const code = resolveKey(key)
    if (code === undefined) return Effect.fail(new Failure({ message: `touche non reconnue: ${key}` }))
    const held = resolveModifiers(modifiers)
    if (held === undefined)
      return Effect.fail(new Failure({ message: `modificateur non reconnu: ${modifiers.join(", ")}` }))
    return invoke(run, keyComboCommand(code, held))
  },
})

const execFileRunner: Runner = async (file, args) => {
  await execFileAsync(file, [...args])
}

export const layerWith = (dependencies: Partial<Dependencies>): Layer.Layer<Service> =>
  Layer.effect(
    Service,
    Effect.sync(() =>
      Service.of(
        make({
          run: dependencies.run ?? execFileRunner,
          platform: dependencies.platform ?? process.platform,
        }),
      ),
    ),
  )

export const layer = layerWith({})

export const node = makeLocationNode({ name: "computer-use", layer, deps: [] })
