export * as LimaBridge from "./lima-bridge"

import { Effect } from "effect"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export interface LimaStatus {
  readonly installed: boolean
  readonly running: boolean
  readonly instanceName?: string
  readonly version?: string
}

/**
 * Détecte la présence et l'état de l'utilitaire Lima sur macOS (limactl).
 */
export const checkStatus = (): Effect.Effect<LimaStatus> =>
  Effect.promise(async () => {
    if (process.platform !== "darwin") {
      return { installed: false, running: false }
    }

    try {
      const { stdout: versionOut } = await execFileAsync("limactl", ["--version"])
      if (!versionOut) {
        return { installed: false, running: false }
      }

      let running = false
      let instanceName: string | undefined

      try {
        const { stdout: listOut } = await execFileAsync("limactl", ["list", "--json"])
        if (listOut) {
          const lines = listOut.trim().split("\n")
          for (const line of lines) {
            try {
              const inst = JSON.parse(line)
              if (inst.status === "Running") {
                running = true
                instanceName = inst.name
                break
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      } catch {
        // ignore list errors
      }

      return {
        installed: true,
        running,
        instanceName,
        version: versionOut.trim(),
      }
    } catch {
      return { installed: false, running: false }
    }
  })
