export * as ScheduleTool from "./schedule"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Schedule } from "../schedule/schedule"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "schedule"

export const Input = Schema.Struct({
  action: Schema.Literals(["create", "list", "remove", "toggle"]).annotate({
    description: "Action: 'create' pour ajouter une tâche, 'list' pour lister, 'remove' pour supprimer, 'toggle' pour activer/désactiver",
  }),
  name: Schema.String.pipe(Schema.optional).annotate({
    description: "Nom de la tâche (requis pour 'create')",
  }),
  cron: Schema.String.pipe(Schema.optional).annotate({
    description: "Expression cron (ex: '0 9 * * *' pour 9h chaque jour, requis pour 'create')",
  }),
  prompt: Schema.String.pipe(Schema.optional).annotate({
    description: "Instruction à exécuter (requis pour 'create')",
  }),
  id: Schema.String.pipe(Schema.optional).annotate({
    description: "ID de la tâche (requis pour 'remove' et 'toggle')",
  }),
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Activer (true) ou désactiver (false) la tâche (requis pour 'toggle')",
  }),
})

export const Output = Schema.Struct({
  text: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const schedule = yield* Schedule.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: "Gérer les tâches planifiées récurrentes du projet (création, liste, activation, suppression).",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            Effect.gen(function* () {
              // A scheduled task runs later, unattended, with whatever rights the runner has. Creating
              // one is therefore a durable grant of authority, not a scratch operation.
              yield* permission.assert({
                action: name,
                resources: [input.action],
                save: [input.action],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              }).pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${name}` })))
              const projectID = location.project.id

              if (input.action === "create") {
                if (!input.name || !input.cron || !input.prompt) {
                  return { text: "Erreur: 'name', 'cron' et 'prompt' sont requis pour créer une tâche planifiée." }
                }
                const entry = yield* schedule.create({
                  project_id: projectID,
                  name: input.name,
                  cron: input.cron,
                  prompt: input.prompt,
                })
                return {
                  text: `Tâche planifiée créée avec succès: [${entry.name}] (${entry.id})\nCron: \`${entry.cron}\`\nPrompt: "${entry.prompt}"`,
                }
              }

              if (input.action === "list") {
                const entries = yield* schedule.list(projectID)
                if (entries.length === 0) {
                  return { text: "Aucune tâche planifiée configurée pour ce projet." }
                }
                const formatted = entries
                  .map(
                    (e) =>
                      `- **${e.name}** (\`${e.id}\`) [${e.enabled ? "✅ Activée" : "⏸️ Désactivée"}]\n  Cron: \`${e.cron}\`\n  Prompt: "${e.prompt}"`,
                  )
                  .join("\n\n")
                return {
                  text: `# Tâches planifiées (${entries.length})\n\n${formatted}`,
                }
              }

              if (input.action === "remove") {
                if (!input.id) {
                  return { text: "Erreur: 'id' est requis pour supprimer une tâche planifiée." }
                }
                yield* schedule.remove(input.id as Schedule.ScheduleID)
                return { text: `Tâche planifiée supprimée: ${input.id}` }
              }

              if (input.action === "toggle") {
                if (!input.id || input.enabled === undefined) {
                  return { text: "Erreur: 'id' et 'enabled' sont requis pour activer/désactiver une tâche planifiée." }
                }
                yield* schedule.setEnabled(input.id as Schedule.ScheduleID, input.enabled)
                return {
                  text: `Tâche planifiée ${input.id} ${input.enabled ? "activée" : "désactivée"}.`,
                }
              }

              return { text: `Action non reconnue: ${input.action}` }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/schedule",
  layer,
  deps: [ToolRegistry.node, Schedule.node, Location.node, PermissionV2.node],
})
