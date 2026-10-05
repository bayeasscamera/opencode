export * as SubagentMarkdownLoader from "./markdown-loader"

import fs from "fs"
import path from "path"
import type { SubagentPersona, SubagentRole } from "./engine"

export interface MarkdownPersonaConfig {
  readonly role: string
  readonly title?: string
  readonly tools?: string[]
  readonly model?: string
}

/**
 * Parse un fichier markdown avec frontmatter YAML pour extraire un persona de sous-agent.
 */
export function parseSubagentMarkdown(filePath: string): SubagentPersona | undefined {
  if (!fs.existsSync(filePath)) return undefined

  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)

    if (!match) {
      // Sans frontmatter, utilise le nom de fichier comme rôle et le contenu comme prompt
      const role = path.basename(filePath, path.extname(filePath))
      return {
        role: role as SubagentRole,
        title: `Agent (${role})`,
        systemPrompt: raw.trim(),
        recommendedTools: ["read", "grep", "glob"],
      }
    }

    const frontmatter = match[1]
    const body = match[2].trim()

    const config: Record<string, string> = {}
    for (const line of frontmatter.split("\n")) {
      const parts = line.split(":")
      if (parts.length >= 2) {
        const key = parts[0].trim()
        const val = parts.slice(1).join(":").trim()
        config[key] = val
      }
    }

    const role = (config.role || path.basename(filePath, path.extname(filePath))).replace(/['"]/g, "")
    const title = (config.title || `Specialized Agent (${role})`).replace(/['"]/g, "")

    let tools: string[] = ["read", "grep", "glob"]
    if (config.tools) {
      tools = config.tools
        .replace(/[\[\]'"]/g, "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    }

    return {
      role: role as SubagentRole,
      title,
      systemPrompt: body || `Sous-agent dédié au rôle : ${title}`,
      recommendedTools: tools,
    }
  } catch {
    return undefined
  }
}

/**
 * Scanne les répertoires standards et retourne les personas déclaratifs découverts.
 * Registration belongs to the caller so no module-level state is mutated.
 */
export function loadProjectSubagents(workdir: string = process.cwd()): SubagentPersona[] {
  const discovered: SubagentPersona[] = []
  const searchDirs = [
    path.join(workdir, ".opencode", "subagents"),
    path.join(workdir, ".agents", "subagents"),
  ]

  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir)
        for (const file of files) {
          if (file.endsWith(".md")) {
            const persona = parseSubagentMarkdown(path.join(dir, file))
            if (persona) discovered.push(persona)
          }
        }
      } catch {
        // Safe failover
      }
    }
  }

  return discovered
}
