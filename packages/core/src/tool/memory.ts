export * as MemoryTool from "./memory"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Memory } from "../memory/memory"
import { Location } from "../location"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const RecordInput = Schema.Struct({
  kind: Schema.Literals(["error_pattern", "project_context", "user_preference"]).annotate({
    description: "Catégorie de mémoire: error_pattern (erreurs et correctifs), project_context (faits clés du projet), user_preference (préférences détectées)",
  }),
  content: Schema.String.annotate({
    description: "Le contenu à mémoriser. Concis et factuel.",
  }),
})

export const ListInput = Schema.Struct({
  kind: Schema.Literals(["error_pattern", "project_context", "user_preference"]).pipe(Schema.optional).annotate({
    description: "Filtrer par catégorie (optionnel). Laisser vide pour tout lister.",
  }),
})

const RecordOutput = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
})

const ListOutput = Schema.Struct({
  count: Schema.Number,
  text: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const memory = yield* Memory.Service
    const location = yield* Location.Service

    yield* tools
      .register({
        memory_record: Tool.make({
          description: "Enregistre une information, un pattern d'erreur ou une préférence persistante pour ce projet.",
          input: RecordInput,
          output: RecordOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const entry = yield* memory.record({
                project_id: location.project.id,
                kind: input.kind,
                content: input.content,
                source_session_id: context.sessionID,
              })
              return {
                success: true,
                message: `Mémoire enregistrée [${entry.kind}]: ${entry.content}`,
              }
            }),
        }),
        memory_list: Tool.make({
          description: "Liste les faits, patterns et préférences mémorisés pour ce projet.",
          input: ListInput,
          output: ListOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input) =>
            Effect.gen(function* () {
              const entries = yield* memory.list(location.project.id, input.kind)
              if (entries.length === 0) {
                return { count: 0, text: "Aucune mémoire enregistrée pour ce projet." }
              }
              const formatted = entries
                .map((e) => `[${e.kind}] (${new Date(e.time_created).toISOString().slice(0, 10)}): ${e.content}`)
                .join("\n")
              return {
                count: entries.length,
                text: `Mémoires trouvées (${entries.length}):\n${formatted}`,
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memory",
  layer,
  deps: [ToolRegistry.node, Memory.node, Location.node],
})
