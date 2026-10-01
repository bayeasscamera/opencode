export * as PathGuard from "./path-guard"

import path from "path"

/** Commandes dangereuses bloquées par mesure de sécurité */
const DANGEROUS_COMMANDS = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|\*)/,
  /\bchmod\s+777\s+\//,
  /\bchown\s+.*\s+\//,
  /\bdd\s+.*of=\/dev/,
  /\bmkfs/,
  /:\(\)\s*\{.*\};\s*:/,
  /\bsudo\s+.*\brm\b/,
  />\s*\/etc\//,
  />\s*\/dev\/(?!null)/,
]

/** Dossiers protégés macOS / UNIX bloqués en écriture */
const FORBIDDEN_MAC_PATHS = [
  /^\/System\//,
  /^\/Library\//,
  /^\/private\//,
  /^\/usr\//,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/etc\//,
  /^\/Applications\//,
]

export interface PathValidationResult {
  readonly allowed: boolean
  readonly reason?: string
}

/**
 * Valide si une commande shell contient des motifs dangereux ou destructeurs.
 */
export function validateCommand(command: string): PathValidationResult {
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Commande bloquée par la sandbox (motif dangereux détecté): ${command.slice(0, 80)}`,
      }
    }
  }
  return { allowed: true }
}

/**
 * Vérifie si un chemin cible est confiné dans le workspace autorisé.
 */
export function isPathContained(targetPath: string, rootDir: string): boolean {
  const resolvedTarget = path.resolve(rootDir, targetPath)
  const resolvedRoot = path.resolve(rootDir)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)
}

/**
 * Valide l'accès à un chemin système.
 */
export function validatePath(targetPath: string, rootDir?: string): PathValidationResult {
  const resolved = path.resolve(targetPath)

  for (const pattern of FORBIDDEN_MAC_PATHS) {
    if (pattern.test(resolved)) {
      return {
        allowed: false,
        reason: `Accès au chemin système interdit: ${resolved}`,
      }
    }
  }

  if (rootDir && !isPathContained(resolved, rootDir)) {
    return {
      allowed: false,
      reason: `Accès hors de l'espace de travail interdit: ${resolved}`,
    }
  }

  return { allowed: true }
}
