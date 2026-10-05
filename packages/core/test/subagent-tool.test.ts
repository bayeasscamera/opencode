import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Path } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SubagentEngine } from "../src/subagent"
import { SubagentRuntime } from "@opencode-ai/core/subagent/runtime"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { SubagentTool } from "@opencode-ai/core/tool/subagent"
import { Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

/**
 * Integration coverage for the real subagent launcher.
 *
 * The whole app graph is built with a scripted LLM provider, so a parent Session run really
 * settles the `subagent` tool, which really creates and runs a child Session. Responses are
 * keyed by the `x-opencode-session-id` request header, so the parent and child scripts never
 * race for the same queue slot.
 */

const DIRECTORY = AbsolutePath.make("/project")
const LOCATION = Location.Ref.make({ directory: DIRECTORY })
const PARENT_ID = SessionV2.ID.make("ses_subagent_parent")
const ENGINE_PROJECT = "subagent-tool-test"

type Turn = ReadonlyArray<LLMEvent> | "hang"

let parentTurns: Turn[] = []
let childTurns: Turn[] = []
const requestsBySession = new Map<string, LLMRequest[]>()

const scripted = (turn: Turn | undefined): Stream.Stream<LLMEvent> => {
  if (turn === undefined) return Stream.empty
  if (turn === "hang") return Stream.never
  return Stream.fromIterable(turn)
}

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      const id = request.http?.headers?.["x-opencode-session-id"] ?? "unknown"
      requestsBySession.set(id, [...(requestsBySession.get(id) ?? []), request])
      return scripted((id === PARENT_ID ? parentTurns : childTurns).shift())
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))

// The runner only reads `agent.info.permissions`; it never consults PermissionV2 while
// materializing tools, so an inert service is enough here.
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)

const systemContext = Layer.mock(SystemContextRegistry.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })

const replacements: LayerNode.Replacements = [
  [LayerNodePlatform.llmClient, client],
  [PermissionV2.node, permission],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: DIRECTORY })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Snapshot.node, Snapshot.noopLayer],
  [Config.node, config],
  [SubagentEngine.node, SubagentEngine.layerWith({ projectID: ENGINE_PROJECT, directory: "/project" })],
]

const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, replacements)

// Minimal stand-ins for the built-in tools so child permission filtering has something to
// remove. The real built-ins are not part of this focused graph.
const fixtureTools = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      read: Tool.make({
        description: "Read a file",
        input: Schema.Struct({ path: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        execute: () => Effect.succeed({ text: "contents" }),
      }),
      write: Tool.make({
        description: "Write a file",
        input: Schema.Struct({ path: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean }),
        execute: () => Effect.succeed({ ok: true }),
      }),
      bash: Tool.make({
        description: "Run a command",
        input: Schema.Struct({ command: Schema.String }),
        output: Schema.Struct({ output: Schema.String }),
        execute: () => Effect.succeed({ output: "" }),
      }),
    }),
  ),
)
const fixtureNode = makeLocationNode({ name: "test/subagent-fixtures", layer: fixtureTools, deps: [ToolRegistry.node] })

const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      fixtureNode,
      SubagentTool.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [...replacements, [SessionExecution.node, execution]],
  ),
)

const textTurn = (id: string, text: string): Turn => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const toolTurn = (call: { id: string; name: string; input: unknown }): Turn => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall(call),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const toolCallsTurn = (calls: ReadonlyArray<{ id: string; name: string; input: unknown }>): Turn => [
  LLMEvent.stepStart({ index: 0 }),
  ...calls.map((call) => LLMEvent.toolCall(call)),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const delegateTurn = (role: string, prompt: string): Turn =>
  toolTurn({ id: "call-subagent", name: "subagent", input: { action: "run", role, prompt } })

const toolParts = (messages: ReadonlyArray<SessionMessage.Message>, name: string) => {
  const parts = messages.flatMap((message) => (message.type === "assistant" ? message.content : []))
  return parts.filter(
    (part): part is Extract<(typeof parts)[number], { type: "tool" }> => part.type === "tool" && part.name === name,
  )
}

const toolPart = (messages: ReadonlyArray<SessionMessage.Message>, name: string) => toolParts(messages, name)[0]

/** `structured` payload a settled tool returned, or undefined while it is still pending. */
const toolStructured = (messages: ReadonlyArray<SessionMessage.Message>, name: string) => {
  const state = toolPart(messages, name)?.state
  return state && (state.status === "completed" || state.status === "error") ? state.structured : undefined
}

/** Text a completed tool returned to the model, or undefined when it did not complete. */
const toolText = (messages: ReadonlyArray<SessionMessage.Message>, name: string) => {
  const text = toolStructured(messages, name)?.["text"]
  return typeof text === "string" ? text : undefined
}

/** Error message a failed tool returned to the model, or undefined when it did not fail. */
const toolError = (messages: ReadonlyArray<SessionMessage.Message>, name: string) => {
  const state = toolPart(messages, name)?.state
  if (state?.status !== "error") return undefined
  const message = (state.error as { message?: unknown }).message
  return typeof message === "string" ? message : undefined
}

const childOf = (sessions: SessionV2.Interface) =>
  Effect.gen(function* () {
    const children = (yield* sessions.list({ directory: DIRECTORY })).filter((session) => session.parentID === PARENT_ID)
    expect(children).toHaveLength(1)
    return children[0]!
  })

/** Polls a predicate on the real clock until it holds or the budget runs out. */
const waitFor = (predicate: Effect.Effect<boolean>, budgetMs = 10_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (yield* predicate) return true
      yield* Effect.sleep("20 millis")
    }
    return false
  })

const reset = Effect.gen(function* () {
  parentTurns = []
  childTurns = []
  requestsBySession.clear()
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: DIRECTORY, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/** Creates the parent Session, publishes the runtime, and scripts one delegate round-trip. */
const harness = (input: {
  role: string
  prompt: string
  child: Turn[]
  parentHead?: Turn
  parentTail?: Turn[]
  publish?: boolean
}) =>
  Effect.gen(function* () {
    yield* reset
    const sessions = yield* SessionV2.Service
    yield* Effect.sync(() => (input.publish === false ? SubagentRuntime.reset() : SubagentRuntime.set(sessions)))
    yield* Effect.addFinalizer(() => Effect.sync(() => SubagentRuntime.reset()))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.rm(path.join(Path.data, "subagents", `${ENGINE_PROJECT}.json`), { force: true })),
    )

    const parent = yield* sessions.create({ id: PARENT_ID, location: LOCATION })
    expect(parent.parentID).toBeUndefined()
    parentTurns = [
      input.parentHead ?? delegateTurn(input.role, input.prompt),
      ...(input.parentTail ?? [textTurn("text-parent", "Done")]),
    ]
    childTurns = [...input.child]
    return sessions
  })

const runParent = (sessions: SessionV2.Interface) =>
  Effect.gen(function* () {
    yield* sessions.prompt({ sessionID: PARENT_ID, prompt: { text: "Delegate this" }, resume: false })
    yield* sessions.resume(PARENT_ID)
  })

describe("subagent tool integration", () => {
  it.live("returns the real child response with state=completed", () =>
    Effect.gen(function* () {
      const sessions = yield* harness({
        role: "researcher",
        prompt: "Find the auth module",
        child: [textTurn("text-child", "Auth module uses JWT tokens.")],
      })

      yield* runParent(sessions)

      const parentMessages = yield* sessions.context(PARENT_ID)
      expect(toolStructured(parentMessages, "subagent")?.["status"]).toBe("completed")
      expect(toolText(parentMessages, "subagent")).toContain('state="completed"')
      expect(toolText(parentMessages, "subagent")).toContain("Auth module uses JWT tokens.")

      const child = yield* childOf(sessions)
      expect(String(child.agent).startsWith("subagent-researcher-")).toBe(true)
    }),
  )

  it.live("denies write to a read-only child role", () =>
    Effect.gen(function* () {
      const sessions = yield* harness({
        role: "researcher",
        prompt: "Try to write",
        child: [toolTurn({ id: "call-write", name: "write", input: { path: "x.txt" } }), textTurn("text-c", "Done")],
      })

      yield* runParent(sessions)

      const child = yield* childOf(sessions)
      const advertised = (requestsBySession.get(child.id)?.[0]?.tools ?? []).map((tool) => tool.name)
      // A researcher keeps read but loses every mutating tool, including subagent itself.
      expect(advertised).toContain("read")
      expect(advertised).not.toContain("write")
      expect(advertised).not.toContain("subagent")

      expect(toolError(yield* sessions.context(child.id), "write")).toBe("Unknown tool: write")
    }),
  )

  it.live("refuses a nested subagent call from the child", () =>
    Effect.gen(function* () {
      const sessions = yield* harness({
        role: "code_builder",
        prompt: "Spawn another agent",
        child: [
          toolTurn({ id: "call-nested", name: "subagent", input: { action: "run", prompt: "nested" } }),
          textTurn("text-c", "Done"),
        ],
      })

      yield* runParent(sessions)

      const child = yield* childOf(sessions)
      const advertised = (requestsBySession.get(child.id)?.[0]?.tools ?? []).map((tool) => tool.name)
      // A builder keeps write and bash, but never the subagent tool itself.
      expect(advertised).toContain("write")
      expect(advertised).toContain("bash")
      expect(advertised).not.toContain("subagent")

      expect(toolError(yield* sessions.context(child.id), "subagent")).toBe("Unknown tool: subagent")
    }),
  )

  it.live("returns state=error when the child exceeds the timeout", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_SUBAGENT_TIMEOUT_MS = "400"
      process.env.OPENCODE_SUBAGENT_POLL_MS = "20"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.OPENCODE_SUBAGENT_TIMEOUT_MS
          delete process.env.OPENCODE_SUBAGENT_POLL_MS
        }),
      )

      const sessions = yield* harness({ role: "general", prompt: "Never finish", child: ["hang"] })

      yield* runParent(sessions)

      const parentMessages = yield* sessions.context(PARENT_ID)
      expect(toolStructured(parentMessages, "subagent")?.["status"]).toBe("error")
      expect(toolText(parentMessages, "subagent")).toContain('state="error"')
      // The hung child was interrupted rather than left active.
      expect(yield* waitFor(sessions.active.pipe(Effect.map((active) => !active.has(PARENT_ID))))).toBe(true)
    }),
  )

  it.live("interrupts the child when the parent run is interrupted", () =>
    Effect.gen(function* () {
      const sessions = yield* harness({ role: "general", prompt: "Hang forever", child: ["hang"] })

      yield* sessions.prompt({ sessionID: PARENT_ID, prompt: { text: "Delegate this" }, resume: false })
      const fiber = yield* sessions.resume(PARENT_ID).pipe(Effect.forkChild)

      const started = yield* waitFor(sessions.active.pipe(Effect.map((active) => active.size > 1)))
      expect(started).toBe(true)

      yield* sessions.interrupt(PARENT_ID)
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)

      const drained = yield* waitFor(sessions.active.pipe(Effect.map((active) => active.size === 0)))
      expect(drained).toBe(true)
    }),
  )

  it.live("returns an error state instead of completing when the session runtime is unpublished", () =>
    Effect.gen(function* () {
      const sessions = yield* harness({
        role: "researcher",
        prompt: "Do it",
        child: [],
        publish: false,
      })

      yield* runParent(sessions)

      const parentMessages = yield* sessions.context(PARENT_ID)
      expect(toolStructured(parentMessages, "subagent")?.["status"]).toBe("error")
      expect(toolText(parentMessages, "subagent")).toContain("n'est pas disponible")
      expect(toolText(parentMessages, "subagent")).not.toContain('state="completed"')
      // No child Session was ever created for the refused run.
      expect(
        (yield* sessions.list({ directory: DIRECTORY })).filter((session) => session.parentID === PARENT_ID),
      ).toHaveLength(0)
    }),
  )

  it.live("runs two concurrent children of the same role without interference", () =>
    Effect.gen(function* () {
      const sessions = yield* harness({
        role: "researcher",
        prompt: "Parallel research",
        // Both children finish on their first provider turn, so each consumes exactly one script.
        child: [textTurn("child-a", "Research result"), textTurn("child-b", "Research result")],
        parentHead: toolCallsTurn([
          { id: "call-a", name: "subagent", input: { action: "run", role: "researcher", prompt: "First" } },
          { id: "call-b", name: "subagent", input: { action: "run", role: "researcher", prompt: "Second" } },
        ]),
      })

      yield* runParent(sessions)

      const parts = toolParts(yield* sessions.context(PARENT_ID), "subagent")
      expect(parts).toHaveLength(2)
      expect(
        parts.map((part) => (part.state.status === "completed" ? part.state.structured["status"] : part.state.status)),
      ).toEqual(["completed", "completed"])

      const children = (yield* sessions.list({ directory: DIRECTORY })).filter(
        (session) => session.parentID === PARENT_ID,
      )
      expect(children).toHaveLength(2)
      // Unique per-task agent ids: neither run can dispose the other's agent when its scope closes.
      expect(new Set(children.map((child) => String(child.agent))).size).toBe(2)
      for (const child of children) {
        expect(String(child.agent).startsWith("subagent-researcher-")).toBe(true)
        const advertised = (requestsBySession.get(child.id)?.[0]?.tools ?? []).map((tool) => tool.name)
        expect(advertised).toContain("read")
        expect(advertised).not.toContain("subagent")
      }
    }),
  )
})
