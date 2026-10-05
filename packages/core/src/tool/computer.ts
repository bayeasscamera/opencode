export * as ComputerTool from "./computer"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { ComputerUse } from "../computer-use"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import path from "path"
import os from "os"

export const name = "computer"

export const Input = Schema.Struct({
  action: Schema.Literals(["screenshot", "click", "type", "key_combo"]).annotate({
    description: "L'action graphique à effectuer: 'screenshot' pour capturer l'écran, 'click', 'type', ou 'key_combo' pour simuler une saisie",
  }),
  text: Schema.String.pipe(Schema.optional).annotate({
    description: "Le texte à taper pour l'action 'type'",
  }),
  key: Schema.String.pipe(Schema.optional).annotate({
    description: "La touche à presser pour l'action 'key_combo' (ex: 'return', 'tab', 'escape')",
  }),
  modifiers: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Modificateurs pour la combinaison de touches (ex: ['command', 'shift'])",
  }),
  targetPath: Schema.String.pipe(Schema.optional).annotate({
    description: "Chemin de destination personnalisé pour le fichier de capture d'écran",
  }),
})

export const Output = Schema.Struct({
  text: Schema.String,
  filePath: Schema.String.pipe(Schema.optional),
})

/**
 * Reduces a desktop action to its failure message, or `undefined` when it worked. The tool answers
 * with a sentence either way, so the mechanism's typed failure never escapes into the registry.
 */
const attempt = (action: Effect.Effect<void, ComputerUse.Failure>): Effect.Effect<string | undefined> =>
  action.pipe(
    Effect.map(() => undefined),
    Effect.catchTag("ComputerUse.Failure", (failure) => Effect.succeed<string | undefined>(failure.message)),
  )

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const computer = yield* ComputerUse.Service

    /**
     * Computer use drives the real desktop: `screenshot` only observes it, while `click`, `type` and
     * `key_combo` act on whatever window currently has focus. The action is the resource, so a caller
     * can allow observation without also allowing input.
     */
    const guarded = <A, E>(input: typeof Input.Type, context: Tool.Context, run: Effect.Effect<A, E>) =>
      permission
        .assert({
          action: name,
          resources: [input.action],
          save: [input.action],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        .pipe(
          Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${name}` })),
          Effect.andThen(run),
        )

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Contrôle d'ordinateur (Computer Use) : prend des captures d'écran pour inspecter visuellement l'application ou l'interface, ou simule des interactions utilisateur.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            guarded(
              input,
              context,
              Effect.gen(function* () {
                if (process.env.OPENCODE_BACKGROUND_WORKER === "true") {
                  if (input.action !== "screenshot") {
                    return {
                      text: `[Sécurité Confinement] L'action '${input.action}' de l'outil computer est strictement interdite pour les agents ou processus s'exécutant en arrière-plan afin d'éviter le détournement d'interface utilisateur.`,
                    }
                  }
                }

                if (input.action === "screenshot") {
                  const dest = input.targetPath || path.join(os.tmpdir(), `opencode-screen-${Date.now()}.png`)
                  const failure = yield* attempt(computer.screenshot(dest))
                  if (failure !== undefined) return { text: `Erreur lors de la capture d'écran: ${failure}` }
                  return {
                    text: `Capture d'écran effectuée avec succès et enregistrée à: ${dest}`,
                    filePath: dest,
                  }
                }

                if (input.action === "type") {
                  if (!input.text) return { text: "Erreur: 'text' est requis pour l'action 'type'." }
                  const failure = yield* attempt(computer.keystroke(input.text))
                  if (failure !== undefined) return { text: `Erreur de saisie: ${failure}` }
                  return { text: `Texte saisi: "${input.text}"` }
                }

                if (input.action === "key_combo") {
                  if (!input.key) return { text: "Erreur: 'key' est requis pour l'action 'key_combo'." }
                  const failure = yield* attempt(computer.keyCombo(input.key, input.modifiers ?? []))
                  if (failure !== undefined) return { text: `Erreur de combinaison: ${failure}` }
                  return { text: `Combinaison de touches simulée: ${input.key}` }
                }

                return { text: `Action inconnue: ${input.action}` }
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/computer",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, ComputerUse.node],
})
