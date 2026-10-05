export * as YouShouldKnow from "./you-should-know"

import { execFile } from "child_process"
import { promisify } from "util"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Path } from "../global"
import { Location } from "../location"

const execFileAsync = promisify(execFile)

export type Severity = "info" | "warning" | "caution"

export interface Observation {
  readonly id: string
  readonly severity: Severity
  readonly category: "git" | "code_quality" | "security" | "dependency"
  readonly message: string
  readonly file?: string
  readonly suggestion?: string
}

export interface Interface {
  readonly inspect: (workdir: string, includeDismissed?: boolean) => Effect.Effect<Observation[]>
  readonly inspectFile: (filePath: string) => Observation[]
  readonly dismiss: (id: string) => Effect.Effect<void>
  readonly resetDismissed: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/YouShouldKnow") {}

function makeId(category: string, key: string): string {
  return crypto.createHash("md5").update(`${category}:${key}`).digest("hex").slice(0, 10)
}

const loadDismissed = (file: string): Set<string> => {
  if (!fs.existsSync(file)) return new Set()
  try {
    return new Set(JSON.parse(fs.readFileSync(file, "utf-8")) as string[])
  } catch {
    return new Set()
  }
}

const saveDismissed = (file: string, dismissed: ReadonlySet<string>) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(Array.from(dismissed)), "utf-8")
  } catch {
    // Fail-safe
  }
}

const make = (input: { projectID: string }) =>
  Effect.gen(function* () {
    // Dismissals are scoped to one project so observer state never leaks across projects.
    const dismissedFile = path.join(Path.state, "observer", `${input.projectID}.json`)
    const dismissed = loadDismissed(dismissedFile)

    const inspect: Interface["inspect"] = (workdir, includeDismissed = false) =>
      Effect.gen(function* () {
        const observations: Observation[] = []

        // 1. Git audit (untracked, modified, unpushed commits)
        const gitStatus = yield* Effect.tryPromise(() =>
          execFileAsync("git", ["status", "--porcelain", "-b"], { cwd: workdir }),
        ).pipe(Effect.option)

        if (gitStatus._tag === "Some") {
          const lines = gitStatus.value.stdout.split("\n").filter((line) => line.trim().length > 0)
          const branchLine = lines.find((line) => line.startsWith("##"))
          if (branchLine?.includes("[ahead")) {
            const match = branchLine.match(/\[ahead\s+(\d+)\]/)
            const aheadCount = match ? match[1] : "plusieurs"
            observations.push({
              id: makeId("git", "unpushed_commits"),
              severity: "info",
              category: "git",
              message: `${aheadCount} commit(s) local(aux) en avance non pushé(s) sur le remote.`,
              suggestion: "Effectuez un 'git push' quand vos tests sont au vert.",
            })
          }

          const untracked = lines.filter((line) => line.startsWith("??")).map((line) => line.slice(3).trim())
          const modified = lines
            .filter((line) => line.startsWith(" M") || line.startsWith("M "))
            .map((line) => line.slice(3).trim())

          if (untracked.length > 0) {
            observations.push({
              id: makeId("git", `untracked_${untracked.length}`),
              severity: "info",
              category: "git",
              message: `${untracked.length} fichier(s) non suivi(s) détecté(s) (ex: ${untracked.slice(0, 3).join(", ")}).`,
              suggestion: "Pensez à les ajouter à git ou au .gitignore s'ils sont temporaires.",
            })
          }

          if (modified.length > 5) {
            observations.push({
              id: makeId("git", `modified_diff_${modified.length}`),
              severity: "warning",
              category: "git",
              message: `${modified.length} fichiers modifiés non commités. L'arbre de travail commence à diverger fortement.`,
              suggestion: "Envisagez de découper vos commits pour réduire le blast radius.",
            })
          }

          const hasPackageJsonModified = modified.some((file) => file.endsWith("package.json"))
          const hasLockfileModified = modified.some((file) => file.includes("lock"))
          if (hasPackageJsonModified && !hasLockfileModified) {
            observations.push({
              id: makeId("dependency", "lockfile_out_of_sync"),
              severity: "warning",
              category: "dependency",
              file: "package.json",
              message: "package.json a été modifié sans mise à jour du lockfile (bun.lockb ou package-lock.json).",
              suggestion: "Lancez 'bun install' ou l'équivalent pour aligner votre lockfile.",
            })
          }
        }

        // 2. Sensitive files at the project root
        const envPath = path.join(workdir, ".env")
        const gitignorePath = path.join(workdir, ".gitignore")
        if (fs.existsSync(envPath) && fs.existsSync(gitignorePath)) {
          try {
            if (!fs.readFileSync(gitignorePath, "utf-8").includes(".env")) {
              observations.push({
                id: makeId("security", "env_not_in_gitignore"),
                severity: "caution",
                category: "security",
                file: ".env",
                message: "Le fichier .env existe mais n'apparaît pas dans .gitignore !",
                suggestion: "Ajoutez immédiatement .env au .gitignore pour éviter toute fuite de clés.",
              })
            }
          } catch {
            // Fail-safe
          }
        }

        try {
          for (const file of fs.readdirSync(workdir)) {
            if (/(\.pem|\.key|id_rsa)$/i.test(file)) {
              observations.push({
                id: makeId("security", `private_key_${file}`),
                severity: "caution",
                category: "security",
                file,
                message: `Fichier de clé cryptographique sensible détecté à la racine : ${file}`,
                suggestion: "Ne commitez jamais de clés privées. Déplacez-les hors de l'arborescence projet.",
              })
            }
          }
        } catch {
          // Fail-safe
        }

        return includeDismissed ? observations : observations.filter((observation) => !dismissed.has(observation.id))
      })

    return Service.of({
      inspect,
      inspectFile,
      dismiss: (id) =>
        Effect.sync(() => {
          dismissed.add(id)
          saveDismissed(dismissedFile, dismissed)
        }),
      resetDismissed: () =>
        Effect.sync(() => {
          dismissed.clear()
          try {
            if (fs.existsSync(dismissedFile)) fs.unlinkSync(dismissedFile)
          } catch {
            // Fail-safe
          }
        }),
    })
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    return yield* make({ projectID: location.project.id })
  }),
)

/** Explicit-identity layer for tests and embedders that do not run under a Location. */
export const layerWith = (input: { projectID: string }) => Layer.effect(Service, make(input))

/**
 * Analyse spécifique d'un fichier pour détecter les résidus de débogage ou anomalies.
 */
export function inspectFile(filePath: string): Observation[] {
  const observations: Observation[] = []
  if (!fs.existsSync(filePath)) return observations

  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 5 * 1024 * 1024) {
      observations.push({
        id: makeId("code_quality", `large_file_${filePath}`),
        severity: "warning",
        category: "code_quality",
        file: filePath,
        message: `Fichier volumineux (${Math.round(stat.size / 1024 / 1024)} Mo). Évitez de le commiter dans git.`,
      })
    }

    if (/(\.ts|\.js|\.tsx|\.jsx|\.py)$/.test(filePath) && stat.size < 1024 * 1024) {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n")
      let debugCount = 0
      lines.forEach((line, index) => {
        if (/\bdebugger\b/.test(line)) {
          observations.push({
            id: makeId("code_quality", `debugger_${filePath}_${index}`),
            severity: "warning",
            category: "code_quality",
            file: `${filePath}:${index + 1}`,
            message: "Instruction 'debugger' trouvée dans le code.",
            suggestion: "Supprimez l'instruction debugger avant de finaliser.",
          })
        }
        if (/\bconsole\.log\(/.test(line) && !line.includes("//")) debugCount++
      })

      if (debugCount > 3) {
        observations.push({
          id: makeId("code_quality", `console_log_${filePath}`),
          severity: "info",
          category: "code_quality",
          file: filePath,
          message: `${debugCount} appels 'console.log' détectés dans ce fichier.`,
          suggestion: "Vérifiez s'il s'agit de traces de debug temporaires à nettoyer.",
        })
      }
    }
  } catch {
    // Fail-safe
  }

  return observations
}

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
