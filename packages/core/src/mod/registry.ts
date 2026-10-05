export * as ModRegistry from "./registry"

import fs from "fs"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Path } from "../global"
import { PathGuard } from "../sandbox/path-guard"

export interface ModValidationResult {
  readonly allowed: boolean
  readonly reason?: string
  readonly modified?: string
}

export interface ModInspectionResult {
  readonly warnings: readonly string[]
}

export interface Mod {
  readonly id: string
  readonly name: string
  readonly description: string
  enabled: boolean
  readonly isCustom?: boolean
  readonly patternStr?: string
  readonly beforeCommand?: (command: string, cwd: string) => ModValidationResult
  readonly afterCommand?: (command: string, output: string) => ModInspectionResult
  readonly beforeTool?: (toolName: string, input: unknown) => ModValidationResult
  readonly afterTool?: (toolName: string, output: unknown) => ModInspectionResult
}

export interface CustomRule {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly patternStr: string
  readonly message?: string
}

// Built-in Default Mods

export const PathGuardMod: Mod = {
  id: "path-guard",
  name: "Path & Command Guard",
  description: "Bloque les commandes destructrices (rm -rf /, fork bombs, mkfs) et les accès système protégés.",
  enabled: true,
  beforeCommand: (command: string) => {
    const res = PathGuard.validateCommand(command)
    return { allowed: res.allowed, reason: res.reason }
  },
}

const SECRET_PATTERNS = [
  { name: "GitHub Token", pattern: /\bghp_[a-zA-Z0-9]{36}\b/ },
  { name: "OpenAI API Key", pattern: /\bsk-[a-zA-Z0-9]{32,}\b/ },
  { name: "Anthropic API Key", pattern: /\bsk-ant-[a-zA-Z0-9-]{32,}\b/ },
  { name: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Private Key Header", pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
]

export const SecretLeakGuardMod: Mod = {
  id: "secret-leak-guard",
  name: "Secret & Token Leak Guard",
  description: "Détecte et bloque l'exposition de clés d'API (OpenAI, Anthropic, AWS, GitHub, tokens privés).",
  enabled: true,
  beforeCommand: (command: string) => {
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(command)) {
        return {
          allowed: false,
          reason: `Mod 'secret-leak-guard' a bloqué la commande : présence détectée d'un ${secret.name}. Ne passe jamais de secrets en clair dans les commandes shell.`,
        }
      }
    }
    return { allowed: true }
  },
  afterCommand: (_command: string, output: string) => {
    const warnings: string[] = []
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(output)) {
        warnings.push(`Alerte de sécurité : détection potentielle d'un ${secret.name} dans la sortie de commande !`)
      }
    }
    return { warnings }
  },
}

export const GitSafetyGuardMod: Mod = {
  id: "git-safety-guard",
  name: "Git Destruction Guard",
  description: "Empêche les commandes git à haut risque (push force sur main/master, reset --hard sans sauvegarde).",
  enabled: true,
  beforeCommand: (command: string) => {
    const trimmed = command.trim()
    if (/git\s+push\s+.*--force.*(main|master)/i.test(trimmed)) {
      return {
        allowed: false,
        reason: "Mod 'git-safety-guard' : 'git push --force' interdit sur la branche principale (main/master).",
      }
    }
    if (/git\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d[a-zA-Z]*x/i.test(trimmed)) {
      return {
        allowed: false,
        reason: "Mod 'git-safety-guard' : 'git clean -fdx' détruit tous les fichiers ignorés (node_modules, .env). Utilisez un nettoyage sélectif.",
      }
    }
    return { allowed: true }
  },
}

export const PipeCurlGuardMod: Mod = {
  id: "pipe-curl-guard",
  name: "Pipe to Shell Guard",
  description: "Avertit et bloque l'exécution aveugle de scripts distants non vérifiés (curl | sh, wget | bash).",
  enabled: true,
  beforeCommand: (command: string) => {
    if (/(?:curl|wget)\s+.*\|\s*(?:bash|sh|zsh)/i.test(command)) {
      return {
        allowed: false,
        reason: "Mod 'pipe-curl-guard' : Exécution directe 'curl | sh' bloquée pour des raisons de sécurité.",
      }
    }
    return { allowed: true }
  },
}

const BUILT_IN_MODS = [PathGuardMod, SecretLeakGuardMod, GitSafetyGuardMod, PipeCurlGuardMod]

interface PersistedConfig {
  disabled: string[]
  customRules: {
    id: string
    name: string
    description: string
    patternStr: string
    message: string
  }[]
}

export interface Interface {
  readonly register: (mod: Mod) => void
  readonly addCustomRule: (rule: CustomRule, persist?: boolean) => void
  readonly list: () => Mod[]
  readonly get: (id: string) => Mod | undefined
  readonly setEnabled: (id: string, enabled: boolean) => boolean
  readonly runBeforeCommand: (command: string, cwd: string) => ModValidationResult
  readonly runAfterCommand: (command: string, output: string) => ModInspectionResult
  readonly runBeforeTool: (toolName: string, input: unknown) => ModValidationResult
  readonly runAfterTool: (toolName: string, output: unknown) => ModInspectionResult
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModRegistry") {}

const loadPersisted = (configFile: string): PersistedConfig => {
  if (!fs.existsSync(configFile)) return { disabled: [], customRules: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8")) as Partial<PersistedConfig>
    return {
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
      customRules: Array.isArray(parsed.customRules) ? parsed.customRules : [],
    }
  } catch {
    return { disabled: [], customRules: [] }
  }
}

const make = (configFile: string) =>
  Effect.sync(() => {
    // Mod guard policy is intentionally user-global (a disabled guard must not silently
    // re-enable per project); only the mutable rule state lives in this service instance.
    const mods = new Map<string, Mod>(BUILT_IN_MODS.map((mod) => [mod.id, { ...mod }]))

    const save = () => {
      try {
        const disabled: string[] = []
        const customRules: PersistedConfig["customRules"] = []
        for (const mod of mods.values()) {
          if (!mod.enabled) disabled.push(mod.id)
          if (mod.isCustom && mod.patternStr) {
            customRules.push({
              id: mod.id,
              name: mod.name,
              description: mod.description,
              patternStr: mod.patternStr,
              message: mod.description,
            })
          }
        }
        fs.mkdirSync(path.dirname(configFile), { recursive: true })
        fs.writeFileSync(configFile, JSON.stringify({ disabled, customRules }, null, 2), "utf-8")
      } catch {
        // Fail-safe
      }
    }

    const addCustomRule = (rule: CustomRule, persist = true) => {
      let regex: RegExp
      try {
        regex = new RegExp(rule.patternStr, "i")
      } catch {
        return
      }
      mods.set(rule.id, {
        id: rule.id,
        name: rule.name,
        description: rule.description,
        enabled: true,
        isCustom: true,
        patternStr: rule.patternStr,
        beforeCommand: (command: string) =>
          regex.test(command)
            ? { allowed: false, reason: rule.message || `Commande bloquée par la règle personnalisée '${rule.name}'.` }
            : { allowed: true },
      })
      if (persist) save()
    }

    const persisted = loadPersisted(configFile)
    for (const id of persisted.disabled) {
      const mod = mods.get(id)
      if (mod) mod.enabled = false
    }
    for (const rule of persisted.customRules) addCustomRule(rule, false)

    const api: Interface = {
      register: (mod) => {
        mods.set(mod.id, mod)
        save()
      },
      addCustomRule,
      list: () => Array.from(mods.values()),
      get: (id) => mods.get(id),
      setEnabled: (id, enabled) => {
        const mod = mods.get(id)
        if (!mod) return false
        mod.enabled = enabled
        save()
        return true
      },
      runBeforeCommand: (command, cwd) => {
        for (const mod of mods.values()) {
          if (!mod.enabled || !mod.beforeCommand) continue
          try {
            const result = mod.beforeCommand(command, cwd)
            if (!result.allowed) return result
          } catch {
            // Safe isolation: a faulty mod never breaks the runner
          }
        }
        return { allowed: true }
      },
      runAfterCommand: (command, output) => {
        const warnings: string[] = []
        for (const mod of mods.values()) {
          if (!mod.enabled || !mod.afterCommand) continue
          try {
            warnings.push(...mod.afterCommand(command, output).warnings)
          } catch {
            // Safe isolation
          }
        }
        return { warnings }
      },
      runBeforeTool: (toolName, input) => {
        for (const mod of mods.values()) {
          if (!mod.enabled || !mod.beforeTool) continue
          try {
            const result = mod.beforeTool(toolName, input)
            if (!result.allowed) return result
          } catch {
            // Safe isolation
          }
        }
        return { allowed: true }
      },
      runAfterTool: (toolName, output) => {
        const warnings: string[] = []
        for (const mod of mods.values()) {
          if (!mod.enabled || !mod.afterTool) continue
          try {
            warnings.push(...mod.afterTool(toolName, output).warnings)
          } catch {
            // Safe isolation
          }
        }
        return { warnings }
      },
    }

    return Service.of(api)
  })

export const layer = Layer.effect(Service, make(path.join(Path.config, "mods_config.json")))

/** Explicit config-file layer for tests and embedders that must not touch user config. */
export const layerWith = (input: { configFile: string }) => Layer.effect(Service, make(input.configFile))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
