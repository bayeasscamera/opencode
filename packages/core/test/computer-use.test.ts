import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { ComputerUse } from "../src/computer-use"

/**
 * Every payload a shell or an AppleScript literal would treat as code. The point of the suite is
 * that none of them are: the service launches programs with an argument array, so a payload can only
 * ever be an argument or a character inside a string literal.
 */
const HOSTILE = ["'; touch /tmp/pwned; echo '", '"$(touch /tmp/pwned)"', "`id`", '" & do shell script "id"']

const PWNED = "/tmp/pwned"

/** The wrapper only; the escaping under test is written out explicitly at each assertion. */
const keystroke = (literal: string) => `tell application "System Events" to keystroke "${literal}"`

const keyCombo = (literal: string) => `tell application "System Events" to key code ${literal}`

let scratch = ""

const launched: ComputerUse.Command[] = []

/**
 * A fake `execFile`: it records exactly what would have been launched and creates the capture file
 * the real `screencapture` would have created, so the success path stays reachable without a desktop.
 * A hostile payload contains slashes, so the parent directories are created rather than assumed.
 */
const run: ComputerUse.Runner = async (file, args) => {
  launched.push({ file, args: [...args] })
  if (file === "screencapture" || file === "scrot") {
    const dest = args[args.length - 1]!
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, "")
  }
}

const darwin = ComputerUse.make({ run, platform: "darwin" })
const linux = ComputerUse.make({ run, platform: "linux" })

const reset = () => {
  launched.length = 0
  fs.rmSync(PWNED, { force: true })
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-computer-use-"))
})

afterAll(() => {
  fs.rmSync(PWNED, { force: true })
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe("ComputerUse hostile input", () => {
  test.each([
    [HOSTILE[0]!, keystroke("'; touch /tmp/pwned; echo '")],
    [HOSTILE[1]!, keystroke('\\"$(touch /tmp/pwned)\\"')],
    [HOSTILE[2]!, keystroke("`id`")],
    [HOSTILE[3]!, keystroke('\\" & do shell script \\"id\\"')],
  ])("types %p as one escaped literal and runs nothing else", async (payload, script) => {
    reset()
    await Effect.runPromise(darwin.keystroke(payload))

    // Exactly one program, launched with exactly one `-e` argument and nothing concatenated.
    expect(launched).toEqual([{ file: "osascript", args: ["-e", script] }])
    expect(fs.existsSync(PWNED)).toBe(false)
  })

  test("escapes the backslash before the quote, so a trailing backslash cannot unescape a quote", () => {
    const BACKSLASH = "\\"
    const QUOTE = '"'
    // `a\"b`: escaping the quote first would yield `a\\"b`, and the backslash pass would then double
    // the backslash it had just inserted — the quote would escape the literal again.
    expect(ComputerUse.escapeAppleScript(`a${BACKSLASH}${QUOTE}b`)).toBe(
      `a${BACKSLASH}${BACKSLASH}${BACKSLASH}${QUOTE}b`,
    )
  })

  test("escapes line breaks, which cannot appear raw inside an AppleScript literal", () => {
    expect(ComputerUse.escapeAppleScript("a\nb")).toBe("a\\nb")
    expect(ComputerUse.escapeAppleScript("a\rb")).toBe("a\\rb")
    expect(ComputerUse.escapeAppleScript("a\tb")).toBe("a\\tb")
  })

  test.each(HOSTILE)("writes %p to the capture path as a plain argument", async (payload) => {
    reset()
    const dest = path.join(scratch, `${payload}.png`)
    await Effect.runPromise(darwin.screenshot(dest))

    // The payload is the last argument of `screencapture`, not a second command.
    expect(launched).toEqual([{ file: "screencapture", args: ["-x", dest] }])
    expect(fs.existsSync(PWNED)).toBe(false)
    expect(fs.existsSync(dest)).toBe(true)
  })

  test("refuses a key that is neither a virtual code nor a known name", async () => {
    reset()
    for (const key of ['36 & do shell script "id"', "return; touch /tmp/pwned", "", "36.5", "not-a-key"]) {
      const failure = await Effect.runPromise(Effect.flip(darwin.keyCombo(key, [])))
      expect(failure).toBeInstanceOf(ComputerUse.Failure)
      expect(failure.message).toContain("touche non reconnue")
    }
    expect(launched).toEqual([])
    expect(fs.existsSync(PWNED)).toBe(false)
  })

  test("refuses a modifier outside the fixed list", async () => {
    reset()
    for (const modifiers of [["super"], ['command down} & do shell script "id"'], ["command", "shift", "nope"]]) {
      const failure = await Effect.runPromise(Effect.flip(darwin.keyCombo("return", modifiers)))
      expect(failure).toBeInstanceOf(ComputerUse.Failure)
      expect(failure.message).toContain("modificateur non reconnu")
    }
    expect(launched).toEqual([])
  })

  test("accepts the four known modifiers and emits them in the fixed order given", async () => {
    reset()
    await Effect.runPromise(darwin.keyCombo("return", ["command", "shift", "option", "control"]))
    expect(launched).toEqual([
      { file: "osascript", args: ["-e", keyCombo('36 using {command down, shift down, option down, control down}')] },
    ])
  })

  test("accepts a bare virtual key code and a known key name", async () => {
    reset()
    await Effect.runPromise(darwin.keyCombo("53", []))
    await Effect.runPromise(darwin.keyCombo("ESCAPE", []))
    expect(launched).toEqual([
      { file: "osascript", args: ["-e", keyCombo("53")] },
      { file: "osascript", args: ["-e", keyCombo("53")] },
    ])
  })

  test("never lets an argument array become a shell word, even with spaces and globs", async () => {
    reset()
    const dest = path.join(scratch, "a b * .png")
    await Effect.runPromise(darwin.screenshot(dest))
    // One argument holding the whole name: no splitting on the space, no glob expansion.
    expect(launched[0]!.args).toEqual(["-x", dest])
  })
})

describe("ComputerUse platform guard", () => {
  test("refuses synthetic input off macOS instead of launching a program", async () => {
    reset()
    const typed = await Effect.runPromise(Effect.flip(linux.keystroke("hello")))
    const combo = await Effect.runPromise(Effect.flip(linux.keyCombo("return", ["command"])))
    expect(typed.message).toContain("macOS")
    expect(combo.message).toContain("macOS")
    expect(launched).toEqual([])
  })

  test("falls back to ImageMagick without a shell `||` chain", async () => {
    reset()
    const dest = path.join(scratch, "linux.png")
    const failing: ComputerUse.Runner = async (file, args) => {
      launched.push({ file, args: [...args] })
      if (file === "scrot") throw new Error("scrot: not found")
      fs.writeFileSync(args[args.length - 1]!, "")
    }
    await Effect.runPromise(ComputerUse.make({ run: failing, platform: "linux" }).screenshot(dest))
    expect(launched).toEqual([
      { file: "scrot", args: [dest] },
      { file: "import", args: ["-window", "root", dest] },
    ])
  })

  test("reports a capture that produced no file", async () => {
    reset()
    const silent: ComputerUse.Runner = async (file, args) => {
      launched.push({ file, args: [...args] })
    }
    const failure = await Effect.runPromise(
      Effect.flip(ComputerUse.make({ run: silent, platform: "darwin" }).screenshot(path.join(scratch, "missing.png"))),
    )
    expect(failure.message).toContain("aucun fichier produit")
  })
})
