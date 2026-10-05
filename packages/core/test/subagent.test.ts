import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import os from "os"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SubagentTool } from "@opencode-ai/core/tool/subagent"
import { SubagentEngine } from "../src/subagent"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const layer = () =>
  SubagentEngine.layerWith({ projectID: `test-${crypto.randomUUID()}`, directory: os.tmpdir() })

const provide = <A, E>(effect: Effect.Effect<A, E, SubagentEngine.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())))

describe("SubagentEngine", () => {
  test("resolves subagent personas", async () => {
    await provide(
      Effect.gen(function* () {
        const engine = yield* SubagentEngine.Service

        const researcher = engine.getPersona("researcher")
        expect(researcher.role).toBe("researcher")
        expect(researcher.recommendedTools).toContain("read")
        expect(researcher.recommendedTools).toContain("grep")

        const builder = engine.getPersona("code_builder")
        expect(builder.recommendedTools).toContain("write")
        expect(builder.recommendedTools).toContain("edit")

        expect(engine.getPersona("code_reviewer").role).toBe("code_reviewer")
        expect(engine.getPersona("ui_designer").title).toContain("Impeccable")
        expect(engine.getPersona("brainstormer").role).toBe("brainstormer")
        expect(engine.getPersona("critic").role).toBe("critic")
        expect(engine.getPersona("editor").role).toBe("editor")
        expect(engine.getPersona("outliner").role).toBe("outliner")
        expect(engine.getPersona("writer").role).toBe("writer")
        expect(engine.getPersona("custom_specialist").role).toBe("custom_specialist")
      }),
    )
  })

  test("never reports success before an explicit transition", async () => {
    await provide(
      Effect.gen(function* () {
        const engine = yield* SubagentEngine.Service
        const task = yield* engine.createTask({ role: "researcher", prompt: "Explore the authentication module" })

        expect(task.status).toBe("registered")
        expect(task.status).not.toBe("completed")
        expect(task.result).toBeUndefined()
        expect(engine.getTask(task.id)?.status).toBe("registered")
      }),
    )
  })

  test("manages subagent tasks lifecycle", async () => {
    await provide(
      Effect.gen(function* () {
        const engine = yield* SubagentEngine.Service
        const task = yield* engine.createTask({
          role: "researcher",
          prompt: "Explore the authentication module",
          background: true,
        })

        expect(task.id).toBeDefined()
        expect(task.background).toBe(true)
        expect(engine.getTask(task.id)?.id).toBe(task.id)

        yield* engine.completeTask(task.id, "Auth module uses JWT tokens and bcrypt.")
        const completed = engine.getTask(task.id)
        expect(completed?.status).toBe("completed")
        expect(completed?.result).toContain("JWT tokens")

        expect(engine.listTasks().some((entry) => entry.id === task.id)).toBe(true)
      }),
    )
  })

  test("cancels active subagent task", async () => {
    await provide(
      Effect.gen(function* () {
        const engine = yield* SubagentEngine.Service
        const task = yield* engine.createTask({ role: "tester", prompt: "Run heavy regression tests" })
        yield* engine.cancelTask(task.id)
        expect(engine.getTask(task.id)?.status).toBe("cancelled")
      }),
    )
  })

  test("appends logs and supports task retry", async () => {
    await provide(
      Effect.gen(function* () {
        const engine = yield* SubagentEngine.Service
        const task = yield* engine.createTask({ role: "code_builder", prompt: "Build database migration" })

        yield* engine.appendLog(task.id, "Step 1: Reading schema files")
        yield* engine.appendLog(task.id, "Step 2: Generating migration sql")
        yield* engine.failTask(task.id, "Syntax error in SQL")

        const failed = engine.getTask(task.id)
        expect(failed?.status).toBe("error")
        expect(failed?.logs.length).toBeGreaterThanOrEqual(4)

        const retried = yield* engine.retryTask(task.id)
        expect(retried?.status).toBe("registered")
        expect(retried?.error).toBeUndefined()
      }),
    )
  })

  test("steers a registered mission with directives", async () => {
    await provide(
      Effect.gen(function* () {
        const engine = yield* SubagentEngine.Service
        const task = yield* engine.createTask({ role: "researcher", prompt: "Analyze security vulnerabilities" })

        const steered = yield* engine.steerTask(task.id, "Focus specifically on SQL injections")
        expect(steered?.pendingDirectives).toContain("Focus specifically on SQL injections")
        expect(steered?.logs.some((log) => log.message.includes("Directive"))).toBe(true)
      }),
    )
  })

  test("isolates task state per project", async () => {
    const program = Effect.gen(function* () {
      const engine = yield* SubagentEngine.Service
      const task = yield* engine.createTask({ role: "general", prompt: "First project mission" })
      return { engine, task }
    })
    const first = await Effect.runPromise(
      program.pipe(Effect.provide(SubagentEngine.layerWith({ projectID: "project-a", directory: os.tmpdir() }))),
    )
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SubagentEngine.Service
        return engine.getTask(first.task.id)
      }).pipe(Effect.provide(SubagentEngine.layerWith({ projectID: "project-b", directory: os.tmpdir() }))),
    )
    expect(second).toBeUndefined()
  })

  test("startTask records the child session and marks the task running", async () => {
    await provide(
      Effect.gen(function* () {
        const engine = yield* SubagentEngine.Service
        const task = yield* engine.createTask({ role: "researcher", prompt: "Explore the auth module" })

        yield* engine.startTask(task.id, "ses_child_1")

        const started = engine.getTask(task.id)
        expect(started?.status).toBe("running")
        expect(started?.sessionID).toBe("ses_child_1")
        expect(started?.logs.some((log) => log.message.includes("ses_child_1"))).toBe(true)
      }),
    )
  })
})

describe("subagent permission rules", () => {
  test("always forbids nested subagents", () => {
    expect(SubagentTool.rulesFor("code_builder")).toEqual([{ action: "subagent", resource: "*", effect: "deny" }])
  })

  test("denies write, edit, apply_patch and bash for read-only roles", () => {
    const rules = SubagentTool.rulesFor("researcher")
    expect(rules.map((rule) => rule.action)).toEqual(["subagent", "write", "edit", "apply_patch", "bash"])
    expect(rules.every((rule) => rule.effect === "deny" && rule.resource === "*")).toBe(true)
  })

  test("keeps a builder role able to write and run commands", () => {
    const denied = SubagentTool.rulesFor("code_builder").map((rule) => rule.action)
    expect(denied).not.toContain("write")
    expect(denied).not.toContain("bash")
  })
})

// Session creation never needs live execution, so the noop execution layer is enough.
const childSession = testEffect(AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]]))

describe("subagent child session", () => {
  childSession.live("records parentID on the child and leaves root sessions unparented", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })

          const parent = yield* sessions.create({ location })
          const child = yield* sessions.create({ location, parentID: parent.id })

          expect(parent.parentID).toBeUndefined()
          expect(child.parentID).toBe(parent.id)
          // Round-trip through the projector and database, not just the in-memory result.
          expect((yield* sessions.get(child.id)).parentID).toBe(parent.id)
        }),
      ),
    ),
  )
})
