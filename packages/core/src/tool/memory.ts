export * as MemoryTool from "./memory"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Memory } from "../memory/memory"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MemoryKinds = [
  "error_pattern",
  "project_context",
  "user_preference",
  "episodic",
  "procedural",
  "semantic",
] as const

export const RecordInput = Schema.Struct({
  kind: Schema.Literals(MemoryKinds).annotate({
    description:
      "Catégorie: error_pattern (erreurs et correctifs), project_context (contexte clé), user_preference (préférences), episodic (interactions et self-healing), procedural (recettes et workflows), semantic (définitions d'architecture)",
  }),
  content: Schema.String.annotate({
    description: "Le contenu à mémoriser. Concis, factuel et précis.",
  }),
})

export const ListInput = Schema.Struct({
  kind: Schema.Literals(MemoryKinds).pipe(Schema.optional).annotate({
    description: "Filtrer par catégorie (optionnel). Laisser vide pour tout lister.",
  }),
})

export const RecallInput = Schema.Struct({
  query: Schema.String.annotate({
    description: "Requête ou mots-clés de recherche dans la mémoire Hindsight.",
  }),
  kind: Schema.Literals(MemoryKinds).pipe(Schema.optional).annotate({
    description: "Filtrer par catégorie (optionnel).",
  }),
})

export const ReflectInput = Schema.Struct({
  topic: Schema.String.pipe(Schema.optional).annotate({
    description: "Sujet ou problème spécifique sur lequel réfléchir (optionnel).",
  }),
})

const RecordOutput = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
})

const TextOutput = Schema.Struct({
  count: Schema.Number,
  text: Schema.String,
})

const ReflectOutput = Schema.Struct({
  reflection: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const memory = yield* Memory.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        memory_record: Tool.make({
          description:
            "Enregistre ou retient (Hindsight retain) une information, un pattern d'erreur, un épisode ou une règle d'architecture pour ce projet.",
          input: RecordInput,
          output: RecordOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              // Only `memory_record` writes. `list`, `recall` and `reflect` read what is already
              // stored, so they stay unguarded: the entry written here is persisted for every later
              // session in this project, which is what needs approval.
              yield* permission.assert({
                action: "memory_record",
                resources: [input.kind],
                save: [input.kind],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              }).pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: memory_record" })))
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
          description: "Liste toutes les mémoires persistantes du projet actuel.",
          input: ListInput,
          output: TextOutput,
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
        memory_recall: Tool.make({
          description:
            "Rappelle (Hindsight recall) les mémoires pertinentes associées à une question, une tâche ou un mot-clé.",
          input: RecallInput,
          output: TextOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input) =>
            Effect.gen(function* () {
              const entries = yield* memory.recall({
                project_id: location.project.id,
                query: input.query,
                kind: input.kind,
              })
              if (entries.length === 0) {
                return { count: 0, text: `Aucune mémoire pertinente pour la requête : '${input.query}'.` }
              }
              const formatted = entries
                .map((e) => `[${e.kind}] (${new Date(e.time_created).toISOString().slice(0, 10)}): ${e.content}`)
                .join("\n")
              return {
                count: entries.length,
                text: `Mémoires rappelées (${entries.length}) pour '${input.query}':\n${formatted}`,
              }
            }),
        }),
        memory_reflect: Tool.make({
          description:
            "Synthétise (Hindsight reflect) les mémoires passées pour dégager des leçons apprises, des patterns récurrents et des recommandations.",
          input: ReflectInput,
          output: ReflectOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.reflection }],
          execute: (input) =>
            Effect.gen(function* () {
              const reflection = yield* memory.reflect({
                project_id: location.project.id,
                topic: input.topic,
              })
              return { reflection }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memory",
  layer,
  deps: [ToolRegistry.node, Memory.node, Location.node, PermissionV2.node],
})
