export * as ReadPdfTool from "./read-pdf"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs"

const execAsync = promisify(exec)

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

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Lit et extrait le texte d'un fichier PDF. Utilise pdftotext (poppler) si disponible, sinon tente une extraction basique. Retourne le contenu textuel structuré page par page.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input) =>
            Effect.promise(async () => {
              const filePath = input.path
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

              const maxPagesArg = maxPages > 0 ? `-l ${maxPages}` : ""

              // Try pdftotext (poppler-utils)
              try {
                const { stdout } = await execAsync(
                  `pdftotext ${maxPagesArg} -layout "${filePath}" -`,
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
                const { stdout } = await execAsync(
                  `python3 -c '${pyScript.replace(/'/g, "'")}' "${filePath}"`,
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
  deps: [ToolRegistry.node],
})
