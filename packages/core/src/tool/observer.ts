export * as ObserverTool from "./observer"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { YouShouldKnow } from "../observer"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "observer"

export const Input = Schema.Struct({
  action: Schema.Literals(["inspect", "check_file", "dismiss", "reset"]).pipe(Schema.optional).annotate({
    description: "Action : 'inspect' pour scanner le workspace, 'check_file' pour analyser un fichier, 'dismiss' pour ignorer une observation, 'reset' pour réactiver toutes les alertes ignorées.",
  }),
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "Chemin du fichier ou dossier à analyser (pour 'check_file' ou 'inspect').",
  }),
  observation_id: Schema.String.pipe(Schema.optional).annotate({
    description: "Identifiant de l'observation à ignorer (pour l'action 'dismiss').",
  }),
})

export const Output = Schema.Struct({
  text: Schema.String,
  count: Schema.Number,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const observer = yield* YouShouldKnow.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    /**
     * `inspect` and `check_file` only read the workspace, so they stay unguarded. `dismiss` and
     * `reset` change the persisted dismissal cache — `reset` deletes it outright — so they ask
     * first. The action is the resource, so a caller can allow dismissing one observation without
     * also allowing a blanket reset.
     */
    const guardMutation = (action: "dismiss" | "reset", context: Tool.Context) =>
      permission
        .assert({
          action: name,
          resources: [action],
          save: [action],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${name}` })))

    yield* tools.register({
      [name]: Tool.make({
        description:
          "Observateur d'arrière-plan 'You Should Know' : audite proactivement l'espace de travail pour détecter oublis de commit, fuites de secrets (.env), traces de débogage et alertes de sécurité.",
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: (input, context) =>
          Effect.gen(function* () {
            const action = input.action ?? "inspect"

            if (action === "check_file") {
              if (!input.path) {
                return {
                  text: "Erreur : 'path' requis pour l'action check_file.",
                  count: 0,
                }
              }
              const obs = observer.inspectFile(input.path)
              if (obs.length === 0) {
                return {
                  text: `✅ Fichier ${input.path} inspecté : aucune anomalie détectée.`,
                  count: 0,
                }
              }

              const formatted = obs
                .map((o) => {
                  const icon = o.severity === "caution" ? "🚨" : o.severity === "warning" ? "⚠️" : "💡"
                  return `${icon} **[${o.category.toUpperCase()}]** ${o.message}${o.suggestion ? `\n   ↳ _Conseil :_ ${o.suggestion}` : ""}`
                })
                .join("\n\n")

              return {
                text: `### 👁️ You Should Know - Audit de ${input.path} (${obs.length}) :\n\n${formatted}`,
                count: obs.length,
              }
            }

            if (action === "dismiss") {
              if (!input.observation_id) {
                return {
                  text: "Erreur : 'observation_id' requis pour ignorer une observation.",
                  count: 0,
                }
              }
              yield* guardMutation(action, context)
              yield* observer.dismiss(input.observation_id)
              return {
                text: `✅ Observation [${input.observation_id}] ignorée et enregistrée en cache persistant.`,
                count: 0,
              }
            }

            if (action === "reset") {
              yield* guardMutation(action, context)
              yield* observer.resetDismissed()
              return {
                text: "✅ Historique des observations ignorées réinitialisé. Toutes les alertes sont réactivées.",
                count: 0,
              }
            }

            // action === "inspect"
            const workdir = input.path || location.project.directory
            const obs = yield* observer.inspect(workdir)

            if (obs.length === 0) {
              return {
                text: "### 👁️ You Should Know : Tout est en ordre.\nAucune anomalie, divergence git ou fuite de configuration détectée.",
                count: 0,
              }
            }

            const formatted = obs
              .map((o) => {
                const icon = o.severity === "caution" ? "🚨" : o.severity === "warning" ? "⚠️" : "💡"
                return `${icon} **[${o.category.toUpperCase()}]** \`[${o.id}]\` ${o.message}${o.suggestion ? `\n   ↳ _Conseil :_ ${o.suggestion}` : ""}`
              })
              .join("\n\n")

            return {
              text: `### 👁️ You Should Know - Observations (${obs.length}) :\n\n${formatted}\n\n_Pour masquer une observation :_ \`observer(action='dismiss', observation_id='<id>')\``,
              count: obs.length,
            }
          }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/observer",
  layer,
  deps: [ToolRegistry.node, YouShouldKnow.node, Location.node, PermissionV2.node],
})
