export * as McpStoreTool from "./mcp-store"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { CATALOG, findById, listByCategory, type McpStoreEntry } from "../mcp-store/catalog"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "mcp_store"

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "info"]).annotate({
    description: "Action à effectuer: 'list' pour lister le catalogue, 'info' pour les détails d'un connecteur",
  }),
  id: Schema.String.pipe(Schema.optional).annotate({
    description: "ID du connecteur pour l'action 'info' (ex: 'brave-search', 'postgres', 'github')",
  }),
  category: Schema.Literals(["search", "database", "devtools", "browser", "filesystem", "productivity"])
    .pipe(Schema.optional)
    .annotate({
      description: "Filtrer par catégorie pour l'action 'list'",
    }),
})

export const Output = Schema.Struct({
  text: Schema.String,
})

const formatEntry = (entry: McpStoreEntry): string => {
  const envSection = entry.env
    ? `\n  Variables d'env nécessaires:\n${Object.entries(entry.env)
        .map(([k, v]) => `    ${k}="${v}"`)
        .join("\n")}`
    : ""
  return `### ${entry.name} (\`${entry.id}\`) - [${entry.category}]
${entry.description}
- Commande: \`${entry.command}\`${envSection}`
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Parcourir et inspecter le catalogue MCP Store pour recommander ou configurer des connecteurs MCP utiles.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            Effect.gen(function* () {
              // Browsing the catalogue is harmless on its own, but the `info` output is a ready-made
              // MCP configuration that a caller can paste into opencode.json. The action is the
              // resource, so a caller can allow listing without also allowing that recommendation.
              yield* permission.assert({
                action: name,
                resources: [input.action],
                save: [input.action],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              }).pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${name}` })))
              if (input.action === "info") {
                if (!input.id) {
                  return { text: "Erreur: 'id' est requis pour l'action 'info'." }
                }
                const entry = findById(input.id)
                if (!entry) {
                  return { text: `Connecteur introuvable avec l'ID: ${input.id}` }
                }
                return {
                  text: `# Connecteur MCP: ${entry.name}\n\n${formatEntry(entry)}\n\nPour l'ajouter dans opencode.json:\n\`\`\`json\n{\n  "mcp": {\n    "${entry.id}": {\n      "type": "local",\n      "command": "${entry.command}"${entry.env ? `,\n      "environment": ${JSON.stringify(entry.env, null, 2)}` : ""}\n    }\n  }\n}\n\`\`\``,
                }
              }

              const entries = listByCategory(input.category)
              const formatted = entries.map(formatEntry).join("\n\n")
              return {
                text: `# Catalogue MCP Store (${entries.length} connecteurs disponibles)\n\n${formatted}`,
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/mcp-store",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
