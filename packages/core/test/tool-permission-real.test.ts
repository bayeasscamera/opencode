import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Database } from "../src/database/database"
import { YouShouldKnow } from "../src/observer"
import { ApplicationTools } from "../src/tool/application-tools"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

/**
 * Unlike `tool-permission-guards.test.ts`, this file does **not** replace `PermissionV2.node`. The
 * real permission service runs inside the location graph, backed by the real `AgentV2`,
 * `SessionStore` and `EventV2`, so what is asserted here is the production resolution path: a
 * Session is looked up, its agent's ruleset is resolved, and the tool suspends on a genuine prompt.
 */

// The real observer writes to `Path.state/observer/<projectID>.json` and `reset` deletes it, so it
// is the only service replaced here — a test must never touch the user's dismissal cache.
const observerCalls: string[] = []
const observer = Layer.succeed(
  YouShouldKnow.Service,
  YouShouldKnow.Service.of({
    inspect: () => Effect.succeed([]),
    inspectFile: () => [],
    dismiss: (id: string) => Effect.sync(() => void observerCalls.push(`dismiss:${id}`)),
    resetDismissed: () => Effect.sync(() => void observerCalls.push("reset")),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]), [
    [YouShouldKnow.node, observer],
  ]),
)

const inLocation = <A, E, R>(directory: string, body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
  )

/**
 * The permission service resolves a Session and then that Session's agent, so both rows have to
 * exist before a tool can be evaluated. In production the project and session services own them.
 */
const seed = (sessionID: SessionV2.ID, directory: string) =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: location.project.id, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: location.project.id,
        slug: "real-permission",
        directory,
        title: "real-permission",
        version: "test",
        // `toolIdentity.agent` is what the registry passes as `context.agent`.
        agent: toolIdentity.agent,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** Replaces the permissions of the agent the tool calls resolve to. */
const setRules = (rules: PermissionV2.Ruleset) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(toolIdentity.agent, (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })

/** Resolves as soon as the real service publishes the prompt it queued for the next tool call. */
const nextPrompt = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const asked = yield* Deferred.make<PermissionV2.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === PermissionV2.Event.Asked.type
      ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  return asked
})

const call = (sessionID: SessionV2.ID, name: string, input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

/** Text a settled tool produced, whichever shape the tool returns. */
const textOf = (settled: { result: { type: string; value?: unknown } }) => JSON.stringify(settled.result)

/**
 * Whether a forked tool call has already produced a result. `pollUnsafe` is the only way to ask in
 * Effect 4 (`Fiber.poll` was removed); it is exact here because the runtime is single threaded and
 * the tool call is known to have reached its `Deferred.await`.
 */
const finished = (fiber: Fiber.Fiber<unknown, unknown>) => fiber.pollUnsafe() !== undefined

describe("built-in tool guards against the real PermissionV2", () => {
  it.live("suspends the tool on an ask and runs it only once the prompt is answered", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        inLocation(
          dir.path,
          Effect.gen(function* () {
            const sessionID = SessionV2.ID.make("ses_real_ask")
            const registry = yield* ToolRegistry.Service
            const permission = yield* PermissionV2.Service

            yield* seed(sessionID, dir.path)
            // No rule names `observer`, so the real resolution is `ask` — not `allow`, not `deny`.
            yield* setRules([])
            expect(PermissionV2.evaluate("observer", "dismiss")).toMatchObject({ effect: "ask" })

            observerCalls.length = 0
            const asked = yield* nextPrompt
            const fiber = yield* settleTool(
              registry,
              call(sessionID, "observer", { action: "dismiss", observation_id: "obs_1" }),
            ).pipe(Effect.forkScoped)

            const request = yield* Deferred.await(asked)
            expect(request).toMatchObject({
              sessionID,
              action: "observer",
              resources: ["dismiss"],
            })
            // The prompt is queued for this session and nothing else.
            expect(yield* permission.forSession(sessionID)).toEqual([request])
            expect(yield* permission.get(request.id)).toEqual(request)

            // The tool has produced no result and the mutation has not happened: it is suspended,
            // not silently authorised.
            expect(finished(fiber)).toBe(false)
            expect(observerCalls).toEqual([])

            // Answering resumes it, and only then does the mutation run.
            yield* permission.reply({ requestID: request.id, reply: "once" })
            const settled = yield* Fiber.join(fiber)
            expect(textOf(settled)).toContain("ignorée")
            expect(observerCalls).toEqual(["dismiss:obs_1"])
            expect(yield* permission.list()).toEqual([])
          }),
        ),
      ),
    ),
  )

  it.live("stops the tool on a targeted deny without prompting, and leaves its sibling action asking", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        inLocation(
          dir.path,
          Effect.gen(function* () {
            const sessionID = SessionV2.ID.make("ses_real_deny")
            const registry = yield* ToolRegistry.Service
            const permission = yield* PermissionV2.Service

            yield* seed(sessionID, dir.path)
            // The rule names one resource of one action, exactly as a user would write it.
            yield* setRules([{ action: "observer", resource: "dismiss", effect: "deny" }])

            observerCalls.length = 0
            const denied = yield* settleTool(
              registry,
              call(sessionID, "observer", { action: "dismiss", observation_id: "obs_1" }),
            )
            expect(textOf(denied)).toContain("Permission denied: observer")
            expect(observerCalls).toEqual([])
            // A `deny` is decided before any prompt is considered, so nothing is queued.
            expect(yield* permission.list()).toEqual([])

            // `reset` is a different resource, so the denial does not leak onto it: it still asks,
            // and answering it runs the mutation.
            const asked = yield* nextPrompt
            const fiber = yield* settleTool(registry, call(sessionID, "observer", { action: "reset" })).pipe(
              Effect.forkScoped,
            )
            const request = yield* Deferred.await(asked)
            expect(request).toMatchObject({ action: "observer", resources: ["reset"] })
            expect(finished(fiber)).toBe(false)
            expect(observerCalls).toEqual([])

            yield* permission.reply({ requestID: request.id, reply: "once" })
            yield* Fiber.join(fiber)
            expect(observerCalls).toEqual(["reset"])
          }),
        ),
      ),
    ),
  )
})
