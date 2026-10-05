import { describe, expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { SubagentRuntime } from "@opencode-ai/core/subagent/runtime"
import { createRoutes as createServerRoutes } from "@opencode-ai/server/routes"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import { Server } from "../src/server/server"

/**
 * The subagent tool reaches `SessionV2` through `SubagentRuntime`, a process-wide holder, because a
 * Location-scoped layer node cannot depend on `SessionV2.node`. Every process that serves Sessions
 * therefore has to publish its built instance. Two servers build their own `SessionV2`, and both are
 * exercised here on their real entrypoint composition rather than on a hand-built layer.
 */

/** `packages/cli/src/commands/handlers/serve.ts`, which is also what the TUI reaches through the daemon. */
const cliServe = Effect.gen(function* () {
  SubagentRuntime.reset()
  yield* Layer.build(
    HttpRouter.serve(createServerRoutes("publication-probe"), { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: "127.0.0.1" })),
      Layer.provide(AppNodeBuilder.build(LayerNode.group([Credential.node, PermissionSaved.node]))),
    ),
  )
  return SubagentRuntime.sessions()
})

/** The desktop sidecar imports `virtual:opencode-server` -> `src/node.ts` -> `Server.listen`. */
const desktopSidecar = Effect.gen(function* () {
  SubagentRuntime.reset()
  // `Server.listen` takes no credentials. `prepareSidecarEnv` in
  // `packages/desktop/src/main/sidecar.ts` puts them in the environment before the
  // server starts, and `ServerAuth` reads them from there.
  const previousUsername = process.env["OPENCODE_SERVER_USERNAME"]
  const previousPassword = process.env["OPENCODE_SERVER_PASSWORD"]
  process.env["OPENCODE_SERVER_USERNAME"] = "opencode"
  process.env["OPENCODE_SERVER_PASSWORD"] = "publication-probe"
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previousUsername === undefined) delete process.env["OPENCODE_SERVER_USERNAME"]
      else process.env["OPENCODE_SERVER_USERNAME"] = previousUsername
      if (previousPassword === undefined) delete process.env["OPENCODE_SERVER_PASSWORD"]
      else process.env["OPENCODE_SERVER_PASSWORD"] = previousPassword
    }),
  )

  const listener = yield* Effect.promise(() =>
    Server.listen({
      port: 0,
      hostname: "127.0.0.1",
      cors: ["oc://renderer"],
      mdns: false,
    }),
  )
  const published = SubagentRuntime.sessions()
  yield* Effect.promise(() => listener.stop())
  return published
})

describe("subagent runtime publication", () => {
  test("the probe can observe an unpublished runtime", () => {
    SubagentRuntime.reset()
    expect(SubagentRuntime.sessions()).toBeUndefined()
  })

  test("the CLI server publishes the SessionV2 it built", async () => {
    const published = await Effect.runPromise(cliServe.pipe(Effect.scoped))
    expect(published).toBeDefined()
  })

  test("the desktop sidecar publishes the SessionV2 it built", async () => {
    const published = await Effect.runPromise(desktopSidecar.pipe(Effect.scoped))
    expect(published).toBeDefined()
  })
})
