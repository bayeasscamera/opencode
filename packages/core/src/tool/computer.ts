export * as ComputerTool from "./computer"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { ComputerUse } from "../computer-use"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
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
    description:
      "La touche à presser pour l'action 'key_combo' : un code de touche virtuel macOS (ex: '36') ou un nom de la liste (return, enter, tab, space, delete, forwarddelete, escape, left, right, up, down, home, end, pageup, pagedown, f1..f12).",
  }),
  modifiers: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Modificateurs pour la combinaison de touches, parmi 'command', 'shift', 'option', 'control'.",
  }),
  targetPath: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Chemin de destination personnalisé pour le fichier de capture d'écran. Relatif à la Location, ou absolu avec l'approbation 'external_directory'.",
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
    const mutation = yield* LocationMutation.Service

    /**
     * Every permission decision this tool makes goes through here, so a refusal names the resource
     * that was refused instead of collapsing into one opaque sentence. `denied` carries it to the
     * registry as a `ToolFailure`.
     */
    const allow = (input: PermissionV2.AssertInput) =>
      permission.assert(input).pipe(
        Effect.catchTag("PermissionV2.BlockedError", () =>
          Effect.fail(new ToolFailure({ message: `Permission denied: ${name} (${input.resources.join(", ")})` })),
        ),
        // A rejection carrying feedback is the user telling the model how to retry, so the feedback
        // is forwarded instead of being flattened into a bare refusal.
        Effect.catchTag("PermissionV2.CorrectedError", (error) =>
          Effect.fail(new ToolFailure({ message: `Permission denied: ${name}: ${error.feedback}` })),
        ),
        Effect.catchTag("Session.NotFoundError", () =>
          Effect.fail(new ToolFailure({ message: `Permission denied: ${name}` })),
        ),
      )

    const source = (context: Tool.Context) => ({
      type: "tool" as const,
      messageID: context.assistantMessageID,
      callID: context.toolCallID,
    })

    /**
     * `targetPath` is a path the model chose, so it is treated like any other tool path: it has to
     * stay inside the Location, and anything outside it needs the same `external_directory` approval
     * the `read` tool asks for. The capture then writes to the canonical path that was approved.
     *
     * Without a `targetPath` the tool picks its own scratch file under the OS temp directory, which
     * is the model asking for nothing in particular rather than naming a path.
     */
    const destination = (input: typeof Input.Type, context: Tool.Context): Effect.Effect<string, ToolFailure> =>
      Effect.gen(function* () {
        if (input.targetPath === undefined) return path.join(os.tmpdir(), `opencode-screen-${Date.now()}.png`)
        const target = yield* mutation.resolve({ path: input.targetPath, kind: "file" }).pipe(
          Effect.mapError((error) =>
            new ToolFailure({
              message:
                error._tag === "LocationMutation.PathError"
                  ? `Invalid targetPath '${error.path}': ${error.reason}`
                  : `Invalid targetPath: ${input.targetPath}`,
            }),
          ),
        )
        if (target.externalDirectory)
          yield* allow({
            ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
            sessionID: context.sessionID,
            agent: context.agent,
            source: source(context),
          })
        return target.canonical
      })

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Contrôle d'ordinateur (Computer Use) : prend des captures d'écran pour inspecter visuellement l'application ou l'interface, ou simule des interactions utilisateur.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            Effect.gen(function* () {
              /**
               * Computer use drives the real desktop: `screenshot` only observes it, while `click`,
               * `type` and `key_combo` act on whatever window currently has focus. The action is the
               * resource, so a caller can allow observation without also allowing input.
               */
              yield* allow({
                action: name,
                resources: [input.action],
                save: [input.action],
                sessionID: context.sessionID,
                agent: context.agent,
                source: source(context),
              })

              if (process.env.OPENCODE_BACKGROUND_WORKER === "true") {
                if (input.action !== "screenshot") {
                  return {
                    text: `[Sécurité Confinement] L'action '${input.action}' de l'outil computer est strictement interdite pour les agents ou processus s'exécutant en arrière-plan afin d'éviter le détournement d'interface utilisateur.`,
                  }
                }
              }

              if (input.action === "screenshot") {
                const dest = yield* destination(input, context)
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
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/computer",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, PermissionV2.node, ComputerUse.node],
})
