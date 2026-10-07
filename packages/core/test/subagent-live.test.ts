import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
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
import { Effect, Layer, Schema } from "effect"
import * as OpenAICompatible from "@opencode-ai/llm/providers/openai-compatible"
import { testEffect } from "./lib/effect"

/**
 * Live validation of the subagent launcher against a REAL provider.
 *
 * Unlike `subagent-tool.test.ts`, the graph keeps the default `LLMClient.layer`, so parent and
 * child turns are real HTTP calls. Only model resolution is replaced. Everything else — child
 * Session creation, ephemeral agent, tool ruleset, run waiting, response extraction — is the
 * production path that the scripted suite proves mechanically.
 *
 * Opt-in, never runs by default:
 *   OPENCODE_LIVE_SUBAGENT=1 bun test test/subagent-live.test.ts
 *
 * Configuration (defaults target a local OpenAI-compatible gateway):
 *   OPENCODE_LIVE_BASE_URL  default http://localhost:20128/v1
 *   OPENCODE_LIVE_MODEL     default auto/best-coding
 *   OPENAI_API_KEY          required by the gateway
 */

const LIVE = process.env.OPENCODE_LIVE_SUBAGENT === "1"
const BASE_URL = process.env.OPENCODE_LIVE_BASE_URL ?? "http://localhost:20128/v1"
const MODEL_ID = process.env.OPENCODE_LIVE_MODEL ?? "auto/best-coding"

const DIRECTORY = AbsolutePath.make("/project")
const LOCATION = Location.Ref.make({ directory: DIRECTORY })
const PARENT_ID = SessionV2.ID.make("ses_subagent_live")
const ENGINE_PROJECT = "subagent-live-test"

const model = OpenAICompatible.configure({
  provider: "live-gateway",
  baseURL: BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
}).model(MODEL_ID)
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))

// Only the parent's `subagent` tool and the child's fixture tools run here; neither consults
// PermissionV2 while materializing (the scripted suite asserts that), so an inert service is enough.
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

// Same stand-ins as the scripted suite: every name the subagent policy talks about is registered,
// so a tool missing from a child's advertised list is a ruleset decision, not a missing registration.
const stub = (description: string) =>
  Tool.make({
    description,
    input: Schema.Struct({ path: Schema.String }),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ ok: true }),
  })

const FIXTURE_TOOL_NAMES = [
  "read",
  "grep",
  "glob",
  "websearch",
  "webfetch",
  "observer",
  "todowrite",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "computer",
  "browser",
  "mod",
  "memory_recall",
  "schedule",
  "mcp_store",
  "mcp__fake__search",
] as const

const fixtureTools = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register(Object.fromEntries(FIXTURE_TOOL_NAMES.map((name) => [name, stub(`Fixture tool ${name}`)]))),
  ),
)
const fixtureNode = makeLocationNode({ name: "test/subagent-live-fixtures", layer: fixtureTools, deps: [ToolRegistry.node] })

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
      SubagentEngine.node,
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

const toolParts = (messages: ReadonlyArray<SessionMessage.Message>, name: string) => {
  const parts = messages.flatMap((message) => (message.type === "assistant" ? message.content : []))
  return parts.filter(
    (part): part is Extract<(typeof parts)[number], { type: "tool" }> => part.type === "tool" && part.name === name,
  )
}

const toolStructured = (messages: ReadonlyArray<SessionMessage.Message>, name: string) => {
  const state = toolParts(messages, name)[0]?.state
  return state && (state.status === "completed" || state.status === "error") ? state.structured : undefined
}

const toolText = (messages: ReadonlyArray<SessionMessage.Message>, name: string) => {
  const text = toolStructured(messages, name)?.["text"]
  return typeof text === "string" ? text : undefined
}

const assistantText = (messages: ReadonlyArray<SessionMessage.Message>) =>
  messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")

const reset = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: DIRECTORY, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const harness = Effect.gen(function* () {
  yield* reset
  const sessions = yield* SessionV2.Service
  yield* Effect.sync(() => SubagentRuntime.set(sessions))
  yield* Effect.addFinalizer(() => Effect.sync(() => SubagentRuntime.reset()))
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => fs.rm(path.join(Path.data, "subagents", `${ENGINE_PROJECT}.json`), { force: true })),
  )
  const parent = yield* sessions.create({ id: PARENT_ID, location: LOCATION })
  expect(parent.parentID).toBeUndefined()
  return sessions
})

const PARENT_INSTRUCTION = [
  'Use the `subagent` tool exactly once with action="run", role="researcher" and',
  'prompt="Answer in one sentence: what is an AI coding agent?".',
  "Wait for its result, then reply with the single word DONE.",
].join(" ")

describe.skipIf(!LIVE)("subagent tool live validation", () => {
  it.live("delegates to a real provider through a real child Session", () =>
    Effect.gen(function* () {
      const sessions = yield* harness

      const started = Date.now()
      yield* sessions.prompt({ sessionID: PARENT_ID, prompt: { text: PARENT_INSTRUCTION }, resume: false })
      yield* sessions.resume(PARENT_ID)
      const elapsedMs = Date.now() - started

      const parentMessages = yield* sessions.context(PARENT_ID)
      const status = toolStructured(parentMessages, "subagent")?.["status"]
      const text = toolText(parentMessages, "subagent") ?? ""

      const children = (yield* sessions.list({ directory: DIRECTORY })).filter(
        (session) => session.parentID === PARENT_ID,
      )
      const child = children[0]
      const childMessages = child ? yield* sessions.context(child.id) : []
      const childText = assistantText(childMessages)

      console.log(
        [
          "",
          "=== sous-agent, provider réel ===",
          `modèle        : ${MODEL_ID} @ ${BASE_URL}`,
          `durée totale  : ${elapsedMs} ms`,
          `statut outil  : ${String(status)}`,
          `session enfant: ${child ? String(child.id) : "aucune"}`,
          `agent enfant  : ${child ? String(child.agent) : "—"}`,
          `réponse enfant: ${childText.slice(0, 300) || "(vide)"}`,
          `texte outil   : ${text.slice(0, 300) || "(vide)"}`,
          "",
        ].join("\n"),
      )

      expect(status).toBe("completed")
      expect(childText.length).toBeGreaterThan(0)
      expect(text).toContain('state="completed"')
      expect(child).toBeDefined()
      expect(String(child?.agent).startsWith("subagent-researcher-")).toBe(true)
    }),
  )
})
