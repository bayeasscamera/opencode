export * as MemoryContext from "./memory-context"

import { Effect, Layer, Schema } from "effect"
import { Memory } from "../memory/memory"
import { Location } from "../location"
import { SystemContext } from "../system-context/index"
import { SystemContextRegistry } from "../system-context/registry"
import { makeLocationNode } from "../effect/app-node"

const key = SystemContext.Key.make("core/memory")

// Codec for the snapshot — an array of MemoryEntry-like objects serialised as JSON.
const MemorySnapshot = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    content: Schema.String,
  }),
)

type MemorySnapshot = typeof MemorySnapshot.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service

    const project_id = location.project.id

    const source = (entries: MemorySnapshot | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(MemorySnapshot),
        load: Effect.succeed(entries),
        baseline: render,
        update: (_prev, current) =>
          current.length === 0
            ? "La mémoire persistante du projet a été effacée."
            : `Mémoire persistante mise à jour :\n\n${render(current)}`,
        removed: () => "La mémoire persistante n'est plus disponible.",
      })

    yield* registry.register({
      key,
      load: memory
        .list(project_id)
        .pipe(
          Effect.map((entries) => {
            if (entries.length === 0) return SystemContext.empty
            const snapshot: MemorySnapshot = entries.map((e) => ({
              id: e.id,
              kind: e.kind,
              content: e.content,
            }))
            return source(snapshot)
          }),
          Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
          Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
        ),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-context",
  layer,
  deps: [Memory.node, Location.node, SystemContextRegistry.node],
})

function render(entries: MemorySnapshot): string {
  if (entries.length === 0) return ""

  const kindLabels: Record<string, string> = {
    error_pattern: "Patterns d'erreurs récurrents",
    project_context: "Contexte du projet",
    user_preference: "Préférences détectées",
  }

  const byKind: Record<string, string[]> = {}
  for (const entry of entries) {
    ;(byKind[entry.kind] ??= []).push(entry.content)
  }

  const sections = Object.entries(byKind).map(([kind, lines]) => {
    const label = kindLabels[kind] ?? kind
    return `### ${label}\n${lines.map((l) => `- ${l}`).join("\n")}`
  })

  return `## 🧠 Mémoire persistante du projet\n\n${sections.join("\n\n")}`
}
