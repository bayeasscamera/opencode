import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { ApplicationTools } from "../src/tool/application-tools"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_tool_guard_test")
const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          denyAction !== undefined && input.action === denyAction
            ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
            : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

// The real built-in graph, with only the permission service replaced. Every tool below is reached
// through the same registry a Session uses, so the assertion runs where it would in production.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]), [
    [PermissionV2.node, permission],
  ]),
)

const reset = () => {
  assertions.length = 0
  denyAction = undefined
}

const call = (name: string, input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

/** Text a settled tool produced, whichever shape the tool returns. */
const textOf = (settled: { result: { type: string; value?: unknown } }) => JSON.stringify(settled.result)

const inLocation = <A, E, R>(directory: string, body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
  )

/**
 * The generated schema does not carry the `memory` table yet, and a fresh database records every
 * migration as complete without running it, so the table has to exist before `memory_record` can
 * write. Same workaround as `memory-hindsight.test.ts`.
 */
const createMemoryTable = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .run(
      sql`CREATE TABLE IF NOT EXISTS memory (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL,
        kind text NOT NULL,
        content text NOT NULL,
        source_session_id text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      )`,
    )
    .pipe(Effect.orDie)
})

describe("built-in tool permission guards", () => {
  it.live("guards computer per action and reaches the desktop only once allowed", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        inLocation(
          dir.path,
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const previous = process.env.OPENCODE_BACKGROUND_WORKER
            // Keeps the allowed branch off the real desktop: the confinement path returns before any
            // AppleScript or screencapture call.
            process.env.OPENCODE_BACKGROUND_WORKER = "true"
            try {
              reset()
              denyAction = "computer"
              const denied = yield* settleTool(registry, call("computer", { action: "click" }))
              expect(textOf(denied)).toContain("Permission denied: computer")

              reset()
              const allowed = yield* settleTool(registry, call("computer", { action: "click" }))
              expect(textOf(allowed)).toContain("Confinement")
              expect(assertions).toMatchObject([{ action: "computer", resources: ["click"] }])
            } finally {
              if (previous === undefined) delete process.env.OPENCODE_BACKGROUND_WORKER
              else process.env.OPENCODE_BACKGROUND_WORKER = previous
            }
          }),
        ),
      ),
    ),
  )

  it.live("guards browser per action", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        inLocation(
          dir.path,
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service

            reset()
            denyAction = "browser"
            const denied = yield* settleTool(registry, call("browser", { action: "navigate" }))
            expect(textOf(denied)).toContain("Permission denied: browser")

            reset()
            // Missing `url` fails validation before any runner is detected, so nothing is spawned.
            const allowed = yield* settleTool(registry, call("browser", { action: "navigate" }))
            expect(textOf(allowed)).toContain("'url' requis")
            expect(assertions).toMatchObject([{ action: "browser", resources: ["navigate"] }])
          }),
        ),
      ),
    ),
  )

  it.live("guards mcp_store", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        inLocation(
          dir.path,
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service

            reset()
            denyAction = "mcp_store"
            const denied = yield* settleTool(registry, call("mcp_store", { action: "list" }))
            expect(textOf(denied)).toContain("Permission denied: mcp_store")

            reset()
            const allowed = yield* settleTool(registry, call("mcp_store", { action: "list" }))
            expect(textOf(allowed)).toContain("Catalogue MCP Store")
            expect(assertions).toMatchObject([{ action: "mcp_store", resources: ["*"] }])
          }),
        ),
      ),
    ),
  )

  it.live("guards schedule per action", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        inLocation(
          dir.path,
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service

            reset()
            denyAction = "schedule"
            const denied = yield* settleTool(registry, call("schedule", { action: "create" }))
            expect(textOf(denied)).toContain("Permission denied: schedule")

            reset()
            // Missing fields fail validation before anything is written.
            const allowed = yield* settleTool(registry, call("schedule", { action: "create" }))
            expect(textOf(allowed)).toContain("'name', 'cron' et 'prompt' sont requis")
            expect(assertions).toMatchObject([{ action: "schedule", resources: ["create"] }])
          }),
        ),
      ),
    ),
  )

  it.live("guards mod per action", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        inLocation(
          dir.path,
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service

            reset()
            denyAction = "mod"
            const denied = yield* settleTool(registry, call("mod", { action: "disable", mod_id: "path-guard" }))
            expect(textOf(denied)).toContain("Permission denied: mod")

            reset()
            const allowed = yield* settleTool(registry, call("mod", { action: "list" }))
            expect(textOf(allowed)).toContain("Mods & Garde-fous")
            expect(assertions).toMatchObject([{ action: "mod", resources: ["list"] }])
          }),
        ),
      ),
    ),
  )

  it.live("guards memory_record, the only memory tool that writes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        inLocation(
          dir.path,
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            yield* createMemoryTable

            reset()
            denyAction = "memory_record"
            const denied = yield* settleTool(
              registry,
              call("memory_record", { kind: "project_context", content: "guarded" }),
            )
            expect(textOf(denied)).toContain("Permission denied: memory_record")

            reset()
            const allowed = yield* settleTool(
              registry,
              call("memory_record", { kind: "project_context", content: "guarded" }),
            )
            expect(textOf(allowed)).toContain("Mémoire enregistrée")
            expect(assertions).toMatchObject([{ action: "memory_record", resources: ["project_context"] }])

            // The reading tools stay unguarded by design.
            reset()
            yield* settleTool(registry, call("memory_list", {}))
            yield* settleTool(registry, call("memory_recall", { query: "guarded" }))
            yield* settleTool(registry, call("memory_reflect", {}))
            expect(assertions).toEqual([])
          }),
        ),
      ),
    ),
  )

  it.live("requires external_directory for read_image outside the Location", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([inside, outside]) =>
        Effect.promise(() =>
          Promise.all([inside[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ).pipe(
      Effect.flatMap(([inside, outside]) =>
        inLocation(
          inside.path,
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const external = `${outside.path}/shot.png`

            reset()
            denyAction = "external_directory"
            const denied = yield* settleTool(registry, call("read_image", { path: external }))
            expect(textOf(denied)).toContain("Unable to read image")

            reset()
            const allowed = yield* settleTool(registry, call("read_image", { path: external }))
            expect(assertions.map((item) => item.action)).toEqual(["external_directory"])

            // An internal path needs no external approval at all.
            reset()
            yield* settleTool(registry, call("read_image", { path: `${inside.path}/shot.png` }))
            expect(assertions).toEqual([])
            expect(textOf(allowed)).toContain("fichier introuvable")
          }),
        ),
      ),
    ),
  )

  it.live("requires external_directory for read_pdf outside the Location", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([inside, outside]) =>
        Effect.promise(() =>
          Promise.all([inside[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ).pipe(
      Effect.flatMap(([inside, outside]) =>
        inLocation(
          inside.path,
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const external = `${outside.path}/doc.pdf`

            reset()
            denyAction = "external_directory"
            const denied = yield* settleTool(registry, call("read_pdf", { path: external }))
            expect(textOf(denied)).toContain("Unable to read PDF")

            reset()
            const allowed = yield* settleTool(registry, call("read_pdf", { path: external }))
            expect(assertions.map((item) => item.action)).toEqual(["external_directory"])

            reset()
            yield* settleTool(registry, call("read_pdf", { path: `${inside.path}/doc.pdf` }))
            expect(assertions).toEqual([])
            expect(textOf(allowed)).toContain("fichier introuvable")
          }),
        ),
      ),
    ),
  )
})
