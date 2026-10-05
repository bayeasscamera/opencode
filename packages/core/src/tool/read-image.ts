export * as ReadImageTool from "./read-image"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs"
import path from "path"

const execAsync = promisify(exec)

export const name = "read_image"

const SUPPORTED_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".svg", ".ico"])

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "Chemin absolu ou relatif vers l'image à analyser (png, jpg, jpeg, gif, webp, bmp, tiff, svg).",
  }),
  mode: Schema.Literals(["metadata", "ocr", "describe"]).pipe(Schema.optional).annotate({
    description:
      "'metadata' (défaut) : dimensions, format, taille. 'ocr' : extrait le texte par OCR (tesseract). 'describe' : description intelligente si un outil CLI est disponible.",
  }),
})

export const Output = Schema.Struct({
  text: Schema.String,
  format: Schema.String.pipe(Schema.optional),
  width: Schema.Number.pipe(Schema.optional),
  height: Schema.Number.pipe(Schema.optional),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Lit et analyse une image : extrait les métadonnées (dimensions, format), le texte via OCR (tesseract), ou génère une description. Supporte png, jpg, gif, webp, bmp, tiff, svg.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input) =>
            Effect.promise(async () => {
              const filePath = input.path
              const mode = input.mode ?? "metadata"

              if (!fs.existsSync(filePath)) {
                return { text: `Erreur: fichier introuvable: ${filePath}` }
              }

              const ext = path.extname(filePath).toLowerCase()
              if (!SUPPORTED_EXTS.has(ext)) {
                return { text: `Format non supporté: ${ext}. Formats supportés: ${[...SUPPORTED_EXTS].join(", ")}` }
              }

              const stat = fs.statSync(filePath)
              const sizeKb = (stat.size / 1024).toFixed(1)

              if (mode === "metadata") {
                // Try file command for basic info
                try {
                  const { stdout } = await execAsync(`file "${filePath}"`)
                  const info = stdout.trim()

                  // Try identify (ImageMagick) for dimensions
                  try {
                    const { stdout: dims } = await execAsync(`identify -format "%wx%h %m" "${filePath}"`)
                    const parts = dims.trim().split(" ")
                    const [wStr, hStr] = (parts[0] || "").split("x")
                    const w = parseInt(wStr || "0", 10)
                    const h = parseInt(hStr || "0", 10)
                    const fmt = parts[1] || ext.slice(1).toUpperCase()
                    return {
                      text: `Fichier: ${path.basename(filePath)}\nFormat: ${fmt}\nDimensions: ${w}x${h}px\nTaille: ${sizeKb} KB\nInfo: ${info}`,
                      format: fmt,
                      width: w,
                      height: h,
                    }
                  } catch {
                    // ImageMagick not available
                  }

                  return {
                    text: `Fichier: ${path.basename(filePath)}\nTaille: ${sizeKb} KB\nInfo: ${info}`,
                    format: ext.slice(1).toUpperCase(),
                  }
                } catch {
                  return {
                    text: `Fichier: ${path.basename(filePath)}\nTaille: ${sizeKb} KB\nFormat: ${ext.slice(1).toUpperCase()}`,
                    format: ext.slice(1).toUpperCase(),
                  }
                }
              }

              if (mode === "ocr") {
                try {
                  const tmpOut = `/tmp/opencode-ocr-${Date.now()}`
                  await execAsync(`tesseract "${filePath}" "${tmpOut}" -l fra+eng 2>/dev/null || tesseract "${filePath}" "${tmpOut}" 2>/dev/null`)
                  const ocrText = fs.existsSync(`${tmpOut}.txt`) ? fs.readFileSync(`${tmpOut}.txt`, "utf-8").trim() : ""
                  try { fs.unlinkSync(`${tmpOut}.txt`) } catch { /* ignore */ }
                  if (!ocrText) return { text: "OCR: aucun texte détecté dans l'image (ou tesseract non disponible)." }
                  return { text: `=== Texte extrait par OCR ===\n\n${ocrText}` }
                } catch {
                  return { text: "OCR indisponible. Installez tesseract: brew install tesseract" }
                }
              }

              if (mode === "describe") {
                // Try llava via ollama if available (local VLM)
                try {
                  const b64 = fs.readFileSync(filePath).toString("base64")
                  const body = JSON.stringify({
                    model: "llava",
                    prompt: "Describe this image concisely in French.",
                    images: [b64],
                    stream: false,
                  })
                  const { stdout } = await execAsync(
                    `curl -s -X POST http://localhost:11434/api/generate -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`,
                    { maxBuffer: 5 * 1024 * 1024 },
                  )
                  const resp = JSON.parse(stdout) as { response?: string }
                  if (resp.response) {
                    return { text: `=== Description de l'image ===\n\n${resp.response}` }
                  }
                } catch { /* ollama not available */ }
                return { text: "Description automatique indisponible. Installez ollama + llava pour la description d'images: https://ollama.ai" }
              }

              return { text: `Mode inconnu: ${mode}` }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/read-image",
  layer,
  deps: [ToolRegistry.node],
})
