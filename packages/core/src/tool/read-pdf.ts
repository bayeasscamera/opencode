export * as ReadPdfTool from "./read-pdf"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { execFile } from "child_process"
import { promisify } from "util"
import fs from "fs"

const execFileAsync = promisify(execFile)

export const name = "read_pdf"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "Chemin absolu ou relatif vers le fichier PDF à lire.",
  }),
  max_pages: Schema.Number.pipe(Schema.optional).annotate({
    description: "Nombre maximal de pages à extraire (défaut: toutes). Utile pour les gros fichiers.",
  }),
})

export const Output = Schema.Struct({
  text: Schema.String,
  page_count: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    /**
     * The tool accepts an arbitrary path, so without this a caller could extract text from a PDF
     * anywhere on the machine. External paths require the same `external_directory` approval the
     * `read` tool asks for, and the read then uses the canonical path that was approved.
     */
    const guarded = <A>(input: typeof Input.Type, context: Tool.Context, run: (path: string) => Promise<A>) =>
      Effect.gen(function* () {
        const target = yield* mutation.resolve({ path: input.path, kind: "file" })
        const external = target.externalDirectory
        if (external)
          yield* permission.assert({
            ...LocationMutation.externalDirectoryPermission(external),
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
        return yield* Effect.promise(() => run(target.canonical))
      }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to read PDF: ${input.path}` })))

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Lit et extrait le texte d'un fichier PDF. Utilise pdftotext (poppler) si disponible, sinon tente une extraction basique. Retourne le contenu textuel structuré page par page.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            guarded(input, context, async (filePath) => {
              const maxPages = input.max_pages ?? 0

              if (!fs.existsSync(filePath)) {
                return {
                  text: `Erreur: fichier introuvable: ${filePath}`,
                  truncated: false,
                }
              }

              const ext = filePath.toLowerCase()
              if (!ext.endsWith(".pdf")) {
                return {
                  text: `Erreur: le fichier n'est pas un PDF: ${filePath}`,
                  truncated: false,
                }
              }

              // Try pdftotext (poppler-utils)
              try {
                const { stdout } = await execFileAsync(
                  "pdftotext",
                  [...(maxPages > 0 ? ["-l", String(maxPages)] : []), "-layout", filePath, "-"],
                  { maxBuffer: 10 * 1024 * 1024 },
                )
                const content = stdout.trim()
                const truncated = content.length > 200_000
                return {
                  text: truncated ? content.slice(0, 200_000) + "\n\n...[Contenu tronqué à 200K caractères]" : content,
                  truncated,
                }
              } catch {
                // Fallback: raw binary scan for text chunks (basic)
              }

              // Try python3 PyMuPDF / pdfminer fallback
              try {
                const pyScript = `
import sys, json
try:
    import fitz
    doc = fitz.open(sys.argv[1])
    pages = list(doc)[:${maxPages > 0 ? maxPages : "len(doc)"}]
    text = "\\n\\n".join(f"=== Page {i+1} ===\\n{p.get_text()}" for i, p in enumerate(pages))
    print(json.dumps({"text": text, "page_count": len(doc)}))
except ImportError:
    from pdfminer.high_level import extract_text
    text = extract_text(sys.argv[1])
    print(json.dumps({"text": text, "page_count": -1}))
`
                const { stdout } = await execFileAsync(
                  "python3",
                  ["-c", pyScript, filePath],
                  { maxBuffer: 10 * 1024 * 1024 },
                )
                const result = JSON.parse(stdout.trim()) as { text: string; page_count: number }
                const truncated = result.text.length > 200_000
                return {
                  text: truncated ? result.text.slice(0, 200_000) + "\n\n...[Tronqué]" : result.text,
                  page_count: result.page_count > 0 ? result.page_count : undefined,
                  truncated,
                }
              } catch {
                // Both failed
              }

              return {
                text: `Impossible d'extraire le contenu PDF de "${filePath}". Installez pdftotext (poppler-utils) ou PyMuPDF (pip install pymupdf).`,
                truncated: false,
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/read-pdf",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, PermissionV2.node],
})
