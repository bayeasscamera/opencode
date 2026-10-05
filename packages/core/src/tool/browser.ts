export * as BrowserTool from "./browser"

import { ToolFailure } from "@opencode-ai/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../effect/app-node"
import { AppProcess } from "../process"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import path from "path"
import os from "os"

export const name = "browser"

export const Input = Schema.Struct({
  action: Schema.Literals(["navigate", "snapshot", "click", "type", "screenshot", "evaluate", "close"]).annotate({
    description: [
      "'navigate': Ouvre une URL dans le navigateur headless.",
      "'snapshot': Retourne le DOM simplifié (texte, liens, boutons) de la page courante.",
      "'click': Clique sur un sélecteur CSS ou un texte de lien.",
      "'type': Tape du texte dans un champ (sélecteur + texte).",
      "'screenshot': Capture la page courante en PNG.",
      "'evaluate': Exécute un snippet JS dans la page et retourne le résultat.",
      "'close': Ferme la session browser.",
    ].join(" "),
  }),
  url: Schema.String.pipe(Schema.optional).annotate({
    description: "URL cible pour l'action 'navigate'.",
  }),
  selector: Schema.String.pipe(Schema.optional).annotate({
    description: "Sélecteur CSS ou texte visible pour 'click' et 'type'.",
  }),
  text: Schema.String.pipe(Schema.optional).annotate({
    description: "Texte à saisir pour l'action 'type'.",
  }),
  script: Schema.String.pipe(Schema.optional).annotate({
    description: "Code JavaScript à exécuter dans la page pour l'action 'evaluate'.",
  }),
  output_path: Schema.String.pipe(Schema.optional).annotate({
    description: "Chemin de sortie pour le screenshot (optionnel).",
  }),
})

export const Output = Schema.Struct({
  text: Schema.String,
  screenshot_path: Schema.String.pipe(Schema.optional),
})

/**
 * Playwright-based browser tool.
 * Requires a local playwright install reachable from node or bun.
 *
 * Falls back to a curl-based snapshot if Playwright is unavailable.
 */

const INSTALL_HINT =
  "Playwright non disponible. Installez-le: bun add playwright && bunx playwright install chromium. Seules 'navigate' et 'snapshot' ont un repli curl."

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024
const RUN_TIMEOUT = Duration.seconds(30)

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value)

/**
 * Static Playwright driver. User-controlled values never enter this source:
 * they travel as one JSON blob through the OC_BROWSER_PARAMS environment
 * variable, and the script is launched through an argv vector without a
 * shell — there is no interpolation surface left to corrupt or escape.
 */
const PLAYWRIGHT_SCRIPT = [
  'const { chromium } = require("playwright")',
  'const params = JSON.parse(process.env.OC_BROWSER_PARAMS)',
  ';(async () => {',
  '  const browser = await chromium.launch({ headless: true })',
  '  const page = await (await browser.newContext()).newPage()',
  '  let out',
  '  if (params.action === "navigate") {',
  '    await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 20000 })',
  '    out = { title: await page.title(), content: await page.evaluate(() => document.body.innerText.slice(0, 8000)) }',
  '  } else if (params.action === "snapshot") {',
  '    const snapshot = await page.evaluate(() => {',
  '      const links = [...document.querySelectorAll("a[href]")].slice(0, 30).map((a) => ({ text: a.innerText.trim(), href: a.href }))',
  '      const buttons = [...document.querySelectorAll("button,input[type=submit]")].slice(0, 20).map((b) => b.innerText.trim() || b.value)',
  '      const text = document.body.innerText.slice(0, 6000)',
  '      return { text, links, buttons }',
  '    })',
  '    out = { url: page.url(), title: await page.title(), ...snapshot }',
  '  } else if (params.action === "click") {',
  '    await page.click(params.selector)',
  '    await page.waitForTimeout(500)',
  '    out = { clicked: params.selector }',
  '  } else if (params.action === "type") {',
  '    await page.fill(params.selector, params.text)',
  '    out = { typed: params.text, into: params.selector }',
  '  } else if (params.action === "screenshot") {',
  '    await page.screenshot({ path: params.screenshotPath, fullPage: false })',
  '    out = { screenshot: params.screenshotPath }',
  '  } else if (params.action === "evaluate") {',
  '    out = { result: await page.evaluate(new Function(params.script)) }',
  '  } else {',
  '    out = { closed: true }',
  '  }',
  '  console.log(JSON.stringify(out))',
  '  await browser.close()',
  '})().catch((error) => {',
  '  console.error(JSON.stringify({ error: String(error && error.message ? error.message : error) }))',
  '  process.exit(1)',
  '})',
].join("\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const appProcess = yield* AppProcess.Service

    // Machine capability, cached per Location layer instance (undefined = unchecked).
    let runnerCache: string | null | undefined = undefined
    const detectRunner = Effect.gen(function* () {
      if (runnerCache !== undefined) return runnerCache
      for (const candidate of ["node", "bun"]) {
        const found = yield* appProcess
          .run(ChildProcess.make(candidate, ["-e", `require("playwright")`], { stdin: "ignore" }), {
            timeout: Duration.seconds(10),
          })
          .pipe(Effect.option)
        if (found._tag === "Some" && found.value.exitCode === 0) {
          runnerCache = candidate
          return candidate
        }
      }
      runnerCache = null
      return null
    })

    const curlSnapshot = (url: string) =>
      Effect.gen(function* () {
        const result = yield* appProcess.run(
          ChildProcess.make("curl", ["-fsSL", "--max-time", "15", "-A", USER_AGENT, url], {
            stdin: "ignore",
            forceKillAfter: Duration.seconds(3),
          }),
          { timeout: Duration.seconds(20), maxOutputBytes: 5 * 1024 * 1024 },
        )
        const text = stripHtml(result.stdout.toString("utf8"))
        return { text: `[Mode curl — Playwright indisponible]\n\nURL: ${url}\n\n${text.slice(0, 10000)}` }
      })

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Contrôle un navigateur web headless (Playwright/Chromium). Permet de naviguer vers des URLs, capturer des snapshots DOM, cliquer sur des éléments, saisir du texte, prendre des screenshots, ou exécuter du JavaScript dans la page. Idéal pour les tests E2E, le scraping, la validation d'interfaces.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input) =>
            Effect.gen(function* () {
              if (input.action === "navigate") {
                if (!input.url) return { text: "Erreur : 'url' requis pour l'action 'navigate'." }
                if (!isHttpUrl(input.url)) return { text: "Erreur : 'url' doit être une URL http(s)." }
              }
              if (input.action === "click" && !input.selector)
                return { text: "Erreur : 'selector' requis pour l'action 'click'." }
              if (input.action === "type" && (!input.selector || !input.text))
                return { text: "Erreur : 'selector' et 'text' requis pour l'action 'type'." }
              if (input.action === "evaluate" && !input.script)
                return { text: "Erreur : 'script' requis pour l'action 'evaluate'." }

              const runner = yield* detectRunner
              if (!runner) {
                if ((input.action === "navigate" || input.action === "snapshot") && input.url && isHttpUrl(input.url))
                  return yield* curlSnapshot(input.url)
                return { text: INSTALL_HINT }
              }

              const screenshotPath = input.output_path || path.join(os.tmpdir(), `opencode-browser-${Date.now()}.png`)
              const params = {
                action: input.action,
                url: input.url,
                selector: input.selector,
                text: input.text,
                script: input.script,
                screenshotPath,
              }
              const result = yield* appProcess.run(
                ChildProcess.make(runner, ["-e", PLAYWRIGHT_SCRIPT], {
                  env: { OC_BROWSER_PARAMS: JSON.stringify(params) },
                  extendEnv: true,
                  stdin: "ignore",
                  forceKillAfter: Duration.seconds(5),
                }),
                { timeout: RUN_TIMEOUT, maxOutputBytes: MAX_OUTPUT_BYTES },
              )
              return parsePlaywrightOutput(input.action, result.stdout.toString("utf8"), screenshotPath)
            }).pipe(
              Effect.catchTag("AppProcessError", (error) => Effect.fail(new Error(error.message))),
              Effect.mapError((error) => new ToolFailure({ message: `Browser action failed: ${error.message}` })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)


/** Tag-stripping replacement for the previous shell sed pipeline. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

function parsePlaywrightOutput(
  action: string,
  stdout: string,
  screenshotPath: string,
): { text: string; screenshot_path?: string } {
  try {
    const data = JSON.parse(stdout.trim()) as Record<string, unknown>

    if (data.error) return { text: `Erreur Playwright: ${data.error}` }

    if (action === "navigate") {
      return {
        text: `=== Page chargée ===\nTitre: ${data.title}\n\n${data.content}`,
      }
    }
    if (action === "snapshot") {
      const links = (data.links as Array<{ text: string; href: string }> | undefined) ?? []
      const buttons = (data.buttons as string[] | undefined) ?? []
      const linksStr = links.map((l) => `  [${l.text}](${l.href})`).join("\n")
      const btnsStr = buttons.map((b) => `  [${b}]`).join(", ")
      return {
        text: `=== Snapshot DOM ===\nURL: ${data.url}\nTitre: ${data.title}\n\n--- Texte ---\n${data.text}\n\n--- Liens (${links.length}) ---\n${linksStr}\n\n--- Boutons ---\n${btnsStr}`,
      }
    }
    if (action === "screenshot") {
      const sp = data.screenshot as string | undefined
      return {
        text: `Screenshot enregistré: ${sp ?? screenshotPath}`,
        screenshot_path: sp ?? screenshotPath,
      }
    }
    if (action === "evaluate") {
      return { text: `Résultat JS: ${JSON.stringify(data.result)}` }
    }
    if (action === "click") return { text: `Cliqué sur: ${data.clicked}` }
    if (action === "type") return { text: `Saisi "${data.typed}" dans: ${data.into}` }
    if (action === "close") return { text: "Session browser fermée." }

    return { text: JSON.stringify(data) }
  } catch {
    return { text: stdout.trim().slice(0, 5000) || "Aucune sortie Playwright." }
  }
}

export const node = makeLocationNode({
  name: "tool/browser",
  layer,
  deps: [ToolRegistry.node, AppProcess.node],
})
