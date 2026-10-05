import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs"
import { sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Database } from "../src/database/database"
import { ComputerUse } from "../src/computer-use"
import { EventV2 } from "../src/event"
import { YouShouldKnow } from "../src/observer"
import { ApplicationTools } from "../src/tool/application-tools"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_tool_guard_test")
const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined
let denyResource: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          (denyAction !== undefined && input.action === denyAction) ||
            (denyResource !== undefined && input.resources.includes(denyResource))
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

// The real observer writes to `Path.state/observer/<projectID>.json` and `reset` deletes that file,
// so the test drives a fake instead of the user's real dismissal cache.
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

// The real controller builds the commands and checks `process.platform`, so the test keeps all of
// that and replaces only the process launch. The `computer` tool therefore has no route to the real
// desktop, and the assertions below are the actual argv that would have been passed.
const desktopCalls: ComputerUse.Command[] = []
const desktop = ComputerUse.layerWith({
  platform: "darwin",
  run: async (file, args) => {
    desktopCalls.push({ file, args: [...args] })
    if (file === "screencapture" || file === "scrot") fs.writeFileSync(args[args.length - 1]!, "")
  },
})

// The real built-in graph, with only the permission service, the observer and the desktop replaced.
// Every tool below is reached through the same registry a Session uses, so the assertion runs where
// it would in production.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]), [
    [PermissionV2.node, permission],
    [YouShouldKnow.node, observer],
    [ComputerUse.node, desktop],
  ]),
)

const reset = () => {
  assertions.length = 0
  observerCalls.length = 0
  desktopCalls.length = 0
  denyAction = undefined
  denyResource = undefined
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
 * Every table the generated schema declares, read straight from SQLite. The harness database is a
 * fresh `:memory:` instance with migrations applied, so this is what a clean install gets.
 */
const tableNames = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const tables = yield* db
    .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .pipe(Effect.orDie)
  return tables.map((table) => table.name)
})

describe("built-in tool permission guards", () => {
  it.live("creates the memory and schedule tables on a fresh database", () =>
    Effect.gen(function* () {
      const names = yield* tableNames
      // A clean install runs `schema.up`, which is the generated schema, and then records every
      // migration as completed without replaying it. So these tables only exist here if the
      // generated schema declares them — no test-side workaround, no migration replay.
      expect(names).toContain("memory")
      expect(names).toContain("schedule")
    }),
  )

  it.live("guards computer per action and drives only the injected desktop", () =>
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
            denyAction = "computer"
            const denied = yield* settleTool(registry, call("computer", { action: "click" }))
            expect(textOf(denied)).toContain("Permission denied: computer")
            // A denied call never reaches the desktop.
            expect(desktopCalls).toEqual([])

            reset()
            const observed = yield* settleTool(registry, call("computer", { action: "screenshot" }))
            expect(textOf(observed)).toContain("Capture d'écran effectuée avec succès")
            expect(assertions).toMatchObject([{ action: "computer", resources: ["screenshot"] }])
            // One launch, and the destination is a separate argument rather than part of a command.
            expect(desktopCalls).toHaveLength(1)
            expect(desktopCalls[0]!.file).toBe("screencapture")
            expect(desktopCalls[0]!.args[0]).toBe("-x")
            expect(desktopCalls[0]!.args[1]).toMatch(/\.png$/)

            reset()
            yield* settleTool(registry, call("computer", { action: "type", text: "bonjour" }))
            expect(desktopCalls).toEqual([
              { file: "osascript", args: ["-e", 'tell application "System Events" to keystroke "bonjour"'] },
            ])
            expect(assertions).toMatchObject([{ action: "computer", resources: ["type"] }])

            reset()
            yield* settleTool(registry, call("computer", { action: "key_combo", key: "return", modifiers: ["command"] }))
            expect(desktopCalls).toEqual([
              {
                file: "osascript",
                args: ["-e", 'tell application "System Events" to key code 36 using {command down}'],
              },
            ])
            expect(assertions).toMatchObject([{ action: "computer", resources: ["key_combo"] }])
          }),
        ),
      ),
    ),
  )

  it.live("confines a caller-supplied targetPath to the Location", () =>
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

            // A relative target stays inside the Location, so it needs no external approval.
            reset()
            yield* settleTool(registry, call("computer", { action: "screenshot", targetPath: "shot.png" }))
            expect(assertions).toMatchObject([{ action: "computer", resources: ["screenshot"] }])
            expect(desktopCalls[0]!.args).toEqual(["-x", `${inside.path}/shot.png`])

            // An absolute target outside the Location needs `external_directory`, like `read`.
            reset()
            denyAction = "external_directory"
            const denied = yield* settleTool(
              registry,
              call("computer", { action: "screenshot", targetPath: `${outside.path}/shot.png` }),
            )
            expect(textOf(denied)).toContain("Permission denied: computer (")
            expect(desktopCalls).toEqual([])

            reset()
            yield* settleTool(
              registry,
              call("computer", { action: "screenshot", targetPath: `${outside.path}/shot.png` }),
            )
            expect(assertions.map((item) => item.action)).toEqual(["computer", "external_directory"])
            expect(desktopCalls[0]!.args).toEqual(["-x", `${outside.path}/shot.png`])

            // A relative path that escapes the Location is rejected outright, with no prompt.
            reset()
            const escaped = yield* settleTool(
              registry,
              call("computer", { action: "screenshot", targetPath: "../escape.png" }),
            )
            expect(textOf(escaped)).toContain("Invalid targetPath")
            expect(desktopCalls).toEqual([])
            expect(assertions).toMatchObject([{ action: "computer", resources: ["screenshot"] }])
          }),
        ),
      ),
    ),
  )

  it.live("confines a background worker without ever touching the desktop", () =>
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
            process.env.OPENCODE_BACKGROUND_WORKER = "true"
            try {
              reset()
              const confined = yield* settleTool(registry, call("computer", { action: "click" }))
              expect(textOf(confined)).toContain("Sécurité Confinement")
              // The confinement check returns before the controller is reached.
              expect(desktopCalls).toEqual([])
              // It still had to ask, so the refusal is not a way to bypass the guard.
              expect(assertions).toMatchObject([{ action: "computer", resources: ["click"] }])

              // Observation stays allowed to a background worker, but still only through the fake.
              reset()
              const observed = yield* settleTool(registry, call("computer", { action: "screenshot" }))
              expect(textOf(observed)).toContain("Capture d'écran effectuée avec succès")
              expect(desktopCalls).toHaveLength(1)
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

  it.live("guards mcp_store per action, so list can be allowed without allowing info", () =>
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

            // A rule naming only `info` leaves `list` alone. `mcp_store` exposes exactly two actions,
            // `list` and `info` — there is no `install`, the tool only recommends a configuration.
            reset()
            denyResource = "info"
            const listed = yield* settleTool(registry, call("mcp_store", { action: "list" }))
            expect(textOf(listed)).toContain("Catalogue MCP Store")
            expect(assertions).toMatchObject([{ action: "mcp_store", resources: ["list"] }])

            const infoDenied = yield* settleTool(registry, call("mcp_store", { action: "info", id: "brave-search" }))
            expect(textOf(infoDenied)).toContain("Permission denied: mcp_store")
            expect(assertions).toMatchObject([
              { action: "mcp_store", resources: ["list"] },
              { action: "mcp_store", resources: ["info"] },
            ])

            // With no rule against it, the same call goes through and reports the action it asked for.
            reset()
            const info = yield* settleTool(registry, call("mcp_store", { action: "info", id: "brave-search" }))
            expect(textOf(info)).toContain("Connecteur MCP")
            expect(assertions).toMatchObject([{ action: "mcp_store", resources: ["info"] }])
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

  it.live("guards observer dismiss and reset, and leaves the two reads alone", () =>
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
            denyAction = "observer"
            const denied = yield* settleTool(
              registry,
              call("observer", { action: "dismiss", observation_id: "obs_1" }),
            )
            expect(textOf(denied)).toContain("Permission denied: observer")
            expect(observerCalls).toEqual([])

            reset()
            const dismissed = yield* settleTool(
              registry,
              call("observer", { action: "dismiss", observation_id: "obs_1" }),
            )
            expect(textOf(dismissed)).toContain("ignorée")
            expect(assertions).toMatchObject([{ action: "observer", resources: ["dismiss"] }])
            expect(observerCalls).toEqual(["dismiss:obs_1"])

            reset()
            yield* settleTool(registry, call("observer", { action: "reset" }))
            expect(assertions).toMatchObject([{ action: "observer", resources: ["reset"] }])
            expect(observerCalls).toEqual(["reset"])

            // The two read-only actions never ask.
            reset()
            yield* settleTool(registry, call("observer", { action: "inspect" }))
            yield* settleTool(registry, call("observer", { action: "check_file", path: "src/index.ts" }))
            expect(assertions).toEqual([])
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
            // `memory.project_id` references `project(id)`, the same way `permission` does, so the
            // resolved project has to exist before the tool can write. In production the project
            // service owns that row; here it is created by hand, as `permission.test.ts` does.
            const location = yield* Location.Service
            const { db } = yield* Database.Service
            yield* db
              .insert(ProjectTable)
              .values({ id: location.project.id, worktree: AbsolutePath.make(dir.path), sandboxes: [] })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)

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
