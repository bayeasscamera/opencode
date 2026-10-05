export * as ComputerTool from "./computer"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { exec } from "child_process"
import { promisify } from "util"
import path from "path"
import os from "os"
import fs from "fs"

const execAsync = promisify(exec)

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

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    /**
     * Computer use drives the real desktop: `screenshot` only observes it, while `click`, `type` and
     * `key_combo` act on whatever window currently has focus. The action is the resource, so a caller
     * can allow observation without also allowing input.
     */
    const guarded = <A>(input: typeof Input.Type, context: Tool.Context, run: () => Promise<A>) =>
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
          Effect.andThen(Effect.promise(run)),
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
            guarded(input, context, async () => {
              if (process.env.OPENCODE_BACKGROUND_WORKER === "true") {
                if (input.action !== "screenshot") {
                  return {
                    text: `[Sécurité Confinement] L'action '${input.action}' de l'outil computer est strictement interdite pour les agents ou processus s'exécutant en arrière-plan afin d'éviter le détournement d'interface utilisateur.`,
                  }
                }
              }

              const isMac = process.platform === "darwin"

              if (input.action === "screenshot") {
                const dest = input.targetPath || path.join(os.tmpdir(), `opencode-screen-${Date.now()}.png`)
                try {
                  if (isMac) {
                    await execAsync(`screencapture -x "${dest}"`)
                  } else {
                    await execAsync(`scrot "${dest}" 2>/dev/null || import -window root "${dest}"`)
                  }

                  if (fs.existsSync(dest)) {
                    return {
                      text: `Capture d'écran effectuée avec succès et enregistrée à: ${dest}`,
                      filePath: dest,
                    }
                  }
                  return { text: "Échec de génération de la capture d'écran." }
                } catch (err) {
                  return { text: `Erreur lors de la capture d'écran: ${err instanceof Error ? err.message : String(err)}` }
                }
              }

              if (!isMac) {
                return { text: `L'action '${input.action}' est actuellement réservée à macOS via AppleScript.` }
              }

              if (input.action === "type") {
                if (!input.text) return { text: "Erreur: 'text' est requis pour l'action 'type'." }
                const safeText = input.text.replace(/"/g, '\\"')
                try {
                  await execAsync(`osascript -e 'tell application "System Events" to keystroke "${safeText}"'`)
                  return { text: `Texte saisi: "${input.text}"` }
                } catch (err) {
                  return { text: `Erreur de saisie: ${err instanceof Error ? err.message : String(err)}` }
                }
              }

              if (input.action === "key_combo") {
                if (!input.key) return { text: "Erreur: 'key' est requis pour l'action 'key_combo'." }
                const mods = input.modifiers?.map((m) => `${m} down`).join(", ") || ""
                const modClause = mods ? ` using {${mods}}` : ""
                try {
                  await execAsync(`osascript -e 'tell application "System Events" to key code "${input.key}"${modClause}'`)
                  return { text: `Combinaison de touches simulée: ${input.key}` }
                } catch (err) {
                  return { text: `Erreur de combinaison: ${err instanceof Error ? err.message : String(err)}` }
                }
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
  deps: [ToolRegistry.node, PermissionV2.node],
})
