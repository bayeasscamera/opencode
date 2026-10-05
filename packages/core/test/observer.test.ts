import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { Path } from "../src/global"
import { YouShouldKnow } from "../src/observer"

const stateFiles: string[] = []
const layerFor = (projectID: string) => {
  stateFiles.push(path.join(Path.state, "observer", `${projectID}.json`))
  return YouShouldKnow.layerWith({ projectID })
}

const provide = <A, E>(
  effect: Effect.Effect<A, E, YouShouldKnow.Service>,
  projectID: string = `test-${crypto.randomUUID()}`,
) => Effect.runPromise(effect.pipe(Effect.provide(layerFor(projectID))))

const tempFile = (name: string, content: string) => {
  const file = path.join(os.tmpdir(), `${name}-${crypto.randomUUID()}.ts`)
  fs.writeFileSync(file, content)
  return file
}

const envWorkdir = () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-env-"))
  fs.writeFileSync(path.join(workdir, ".env"), "SECRET=1\n")
  fs.writeFileSync(path.join(workdir, ".gitignore"), "node_modules\n")
  return workdir
}

afterAll(() => {
  for (const file of stateFiles) {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})

describe("YouShouldKnow observer", () => {
  test("inspects workspace git and security state", async () => {
    await provide(
      Effect.gen(function* () {
        const observer = yield* YouShouldKnow.Service
        const observations = yield* observer.inspect(process.cwd())
        expect(Array.isArray(observations)).toBe(true)
      }),
    )
  })

  test("inspects file for debugger and console.log leftovers", async () => {
    const file = tempFile(
      "observer-debug",
      [
        "export function testFn() {",
        '  console.log("debug 1")',
        '  console.log("debug 2")',
        '  console.log("debug 3")',
        '  console.log("debug 4")',
        "  debugger",
        "  return 42",
        "}",
      ].join("\n"),
    )

    await provide(
      Effect.gen(function* () {
        const observer = yield* YouShouldKnow.Service
        const observations = observer.inspectFile(file)
        expect(observations.some((entry) => entry.message.includes("debugger"))).toBe(true)
        expect(observations.some((entry) => entry.message.includes("console.log"))).toBe(true)
      }),
    )
    fs.unlinkSync(file)
  })

  test("handles clean files gracefully", async () => {
    const file = tempFile("observer-clean", "export const value = 123\n")
    await provide(
      Effect.gen(function* () {
        const observer = yield* YouShouldKnow.Service
        expect(observer.inspectFile(file).length).toBe(0)
      }),
    )
    fs.unlinkSync(file)
  })

  test("dismisses observations and filters them out", async () => {
    const workdir = envWorkdir()
    await provide(
      Effect.gen(function* () {
        const observer = yield* YouShouldKnow.Service
        const all = yield* observer.inspect(workdir, true)
        const envObservation = all.find((entry) => entry.file === ".env")
        if (!envObservation) throw new Error("expected the .env observation")

        yield* observer.dismiss(envObservation.id)
        const active = yield* observer.inspect(workdir, false)
        expect(active.some((entry) => entry.id === envObservation.id)).toBe(false)

        yield* observer.resetDismissed()
        const restored = yield* observer.inspect(workdir, false)
        expect(restored.some((entry) => entry.id === envObservation.id)).toBe(true)
      }),
    )
  })

  test("isolates dismissals per project", async () => {
    const workdir = envWorkdir()
    const projectA = `test-a-${crypto.randomUUID()}`
    const projectB = `test-b-${crypto.randomUUID()}`

    await provide(
      Effect.gen(function* () {
        const observer = yield* YouShouldKnow.Service
        const all = yield* observer.inspect(workdir, true)
        const envObservation = all.find((entry) => entry.file === ".env")
        if (!envObservation) throw new Error("expected the .env observation")
        yield* observer.dismiss(envObservation.id)
        const active = yield* observer.inspect(workdir, false)
        expect(active.some((entry) => entry.id === envObservation.id)).toBe(false)
      }),
      projectA,
    )

    await provide(
      Effect.gen(function* () {
        const observer = yield* YouShouldKnow.Service
        const active = yield* observer.inspect(workdir, false)
        expect(active.some((entry) => entry.file === ".env")).toBe(true)
      }),
      projectB,
    )
  })
})
