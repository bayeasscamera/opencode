export * as ModTool from "./mod"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { ModRegistry } from "../mod"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "mod"

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "enable", "disable", "check", "add_rule"]).pipe(Schema.optional).annotate({
    description: "Action : 'list' pour afficher, 'enable'/'disable' pour basculer, 'check' pour tester, 'add_rule' pour créer une règle personnalisée.",
  }),
  mod_id: Schema.String.pipe(Schema.optional).annotate({
    description: "Identifiant du mod (ex: 'path-guard', 'secret-leak-guard', 'git-safety-guard').",
  }),
  command: Schema.String.pipe(Schema.optional).annotate({
    description: "Commande à tester avec l'action 'check'.",
  }),
  pattern: Schema.String.pipe(Schema.optional).annotate({
    description: "Expression régulière du motif dangereux pour l'action 'add_rule'.",
  }),
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "Description de la règle pour l'action 'add_rule'.",
  }),
})

export const Output = Schema.Struct({
  text: Schema.String,
  success: Schema.Boolean,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mods = yield* ModRegistry.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools.register({
      [name]: Tool.make({
        description:
          "Système de Mods & Garde-fous TypeScript (Claude Mods) : inspecte, active ou désactive les règles de sécurité et de blocage pré-exécution.",
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: (input, context) =>
          Effect.gen(function* () {
            // `enable`, `disable` and `add_rule` weaken the guard rails that every other tool relies
            // on, so the caller must approve the action rather than the tool as a whole.
            yield* permission.assert({
              action: name,
              resources: [input.action ?? "list"],
              save: [input.action ?? "list"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${name}` })))
            const action = input.action ?? "list"

            if (action === "list") {
              const entries = mods.list()
              const lines = entries.map(
                (m) =>
                  `- **${m.name}** (\`${m.id}\`) : ${m.enabled ? "✅ Actif" : "❌ Désactivé"}\n  _${m.description}_`,
              )
              return {
                text: `### Mods & Garde-fous actifs (${entries.length}) :\n\n${lines.join("\n\n")}`,
                success: true,
              }
            }

            if (action === "enable" || action === "disable") {
              if (!input.mod_id) {
                return {
                  text: "Erreur : 'mod_id' requis pour activer ou désactiver un mod.",
                  success: false,
                }
              }
              const enabled = action === "enable"
              const updated = mods.setEnabled(input.mod_id, enabled)
              if (!updated) {
                return {
                  text: `Mod '${input.mod_id}' introuvable.`,
                  success: false,
                }
              }
              return {
                text: `Mod '${input.mod_id}' ${enabled ? "activé" : "désactivé"} avec succès.`,
                success: true,
              }
            }

            if (action === "check") {
              if (!input.command) {
                return {
                  text: "Erreur : 'command' requise pour tester la validation par les mods.",
                  success: false,
                }
              }
              const res = mods.runBeforeCommand(input.command, location.project.directory)
              if (!res.allowed) {
                return {
                  text: `⚠️ Commande BLOQUÉE par les mods :\n${res.reason}`,
                  success: false,
                }
              }
              return {
                text: `✅ Commande autorisée par tous les mods actifs.`,
                success: true,
              }
            }

            if (action === "add_rule") {
              if (!input.mod_id || !input.pattern) {
                return {
                  text: "Erreur : 'mod_id' et 'pattern' sont requis pour ajouter une règle de mod personnalisée.",
                  success: false,
                }
              }
              mods.addCustomRule({
                id: input.mod_id,
                name: input.mod_id,
                description: input.description || `Règle personnalisée bloquant le motif : ${input.pattern}`,
                patternStr: input.pattern,
              })
              return {
                text: `✅ Règle de mod '${input.mod_id}' ajoutée et persistée avec succès.`,
                success: true,
              }
            }

            return {
              text: `Action inconnue : ${action}`,
              success: false,
            }
          }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/mod",
  layer,
  deps: [ToolRegistry.node, ModRegistry.node, Location.node, PermissionV2.node],
})
