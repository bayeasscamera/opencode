export * as Memory from "./memory"

import { Context, Effect, Layer } from "effect"
import { eq, desc, and } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { MemoryTable, type MemoryID, type MemoryKind } from "./sql"
import { ProjectV2 } from "../project"
import { SessionSchema } from "../session/schema"
import crypto from "crypto"

// ─── Types ──────────────────────────────────────────────────────────────────

export type { MemoryKind, MemoryID }

export interface MemoryEntry {
  readonly id: MemoryID
  readonly project_id: ProjectV2.ID
  readonly kind: MemoryKind
  readonly content: string
  readonly source_session_id: SessionSchema.ID | null
  readonly time_created: number
  readonly time_updated: number
}

// ─── Interface & Service ────────────────────────────────────────────────────

export interface Interface {
  /** Record a new memory (or update if same project+kind+content already exists). */
  readonly record: (input: {
    project_id: ProjectV2.ID
    kind: MemoryKind
    content: string
    source_session_id?: SessionSchema.ID
  }) => Effect.Effect<MemoryEntry>

  /** Retain information (Hindsight paradigm alias for record). */
  readonly retain: (input: {
    project_id: ProjectV2.ID
    kind?: MemoryKind
    content: string
    source_session_id?: SessionSchema.ID
  }) => Effect.Effect<MemoryEntry>

  /** List all memories for a project, newest first. */
  readonly list: (project_id: ProjectV2.ID, kind?: MemoryKind) => Effect.Effect<MemoryEntry[]>

  /** Recall memories matching a query (Hindsight paradigm). */
  readonly recall: (input: {
    project_id: ProjectV2.ID
    query: string
    kind?: MemoryKind
  }) => Effect.Effect<MemoryEntry[]>

  /** Reflect and synthesize insights over memories for a topic (Hindsight paradigm). */
  readonly reflect: (input: {
    project_id: ProjectV2.ID
    topic?: string
  }) => Effect.Effect<string>

  /** Remove a specific memory by ID. */
  readonly remove: (id: MemoryID) => Effect.Effect<void>

  /** Remove all memories for a project. */
  readonly clear: (project_id: ProjectV2.ID) => Effect.Effect<void>

  /**
   * Render memories as a markdown block ready to be injected into a system prompt.
   * Returns undefined when no memories exist for this project.
   */
  readonly render: (project_id: ProjectV2.ID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Memory") {}

// ─── Layer ──────────────────────────────────────────────────────────────────

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const record: Interface["record"] = (input) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID() as MemoryID
        const now = Date.now()
        const entry = {
          id,
          project_id: input.project_id,
          kind: input.kind,
          content: input.content,
          source_session_id: input.source_session_id ?? null,
          time_created: now,
          time_updated: now,
        }
        yield* db.insert(MemoryTable).values(entry).onConflictDoNothing().pipe(Effect.orDie)
        return entry as MemoryEntry
      })

    const retain: Interface["retain"] = (input) =>
      record({
        project_id: input.project_id,
        kind: input.kind ?? "project_context",
        content: input.content,
        source_session_id: input.source_session_id,
      })

    const list: Interface["list"] = (project_id, kind) =>
      Effect.gen(function* () {
        const where = kind
          ? and(eq(MemoryTable.project_id, project_id), eq(MemoryTable.kind, kind))
          : eq(MemoryTable.project_id, project_id)
        const rows = yield* db
          .select()
          .from(MemoryTable)
          .where(where)
          .orderBy(desc(MemoryTable.time_created))
          .pipe(Effect.orDie)
        return rows as MemoryEntry[]
      })

    const recall: Interface["recall"] = (input) =>
      Effect.gen(function* () {
        const all = yield* list(input.project_id, input.kind)
        const queryTerms = input.query
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 1)

        if (queryTerms.length === 0) return all

        return all.filter((entry) => {
          const contentLower = entry.content.toLowerCase()
          const kindLower = entry.kind.toLowerCase()
          return queryTerms.some((term) => contentLower.includes(term) || kindLower.includes(term))
        })
      })

    const reflect: Interface["reflect"] = (input) =>
      Effect.gen(function* () {
        const memories = input.topic
          ? yield* recall({ project_id: input.project_id, query: input.topic })
          : yield* list(input.project_id)

        if (memories.length === 0) {
          return input.topic
            ? `Aucune mémoire enregistrée en lien avec le sujet : '${input.topic}'.`
            : "Aucune mémoire enregistrée pour ce projet."
        }

        const byKind: Record<string, string[]> = {}
        for (const m of memories) {
          ;(byKind[m.kind] ??= []).push(m.content)
        }

        const kindLabels: Record<string, string> = {
          error_pattern: "Erreurs & Résolutions antérieures",
          project_context: "Contexte & Règles clés",
          user_preference: "Préférences observées",
          episodic: "Épisodes d'exécution & Self-healing",
          procedural: "Procédures & Recettes validées",
          semantic: "Définitions & Contrats d'architecture",
        }

        const sections = Object.entries(byKind).map(([kind, items]) => {
          const label = kindLabels[kind] ?? kind
          const lines = items.map((c) => `- ${c}`).join("\n")
          return `#### ${label} (${items.length})\n${lines}`
        })

        const topicHeader = input.topic ? ` pour le sujet '${input.topic}'` : ""
        return `### 🧠 Hindsight Reflection${topicHeader} (${memories.length} mémoires analysées) :\n\n${sections.join("\n\n")}`
      })

    const remove: Interface["remove"] = (id) =>
      db.delete(MemoryTable).where(eq(MemoryTable.id, id)).pipe(Effect.orDie, Effect.asVoid)

    const clear: Interface["clear"] = (project_id) =>
      db.delete(MemoryTable).where(eq(MemoryTable.project_id, project_id)).pipe(Effect.orDie, Effect.asVoid)

    const render: Interface["render"] = (project_id) =>
      Effect.gen(function* () {
        const entries = yield* list(project_id)
        if (entries.length === 0) return undefined

        const byKind: Record<string, MemoryEntry[]> = {}
        for (const entry of entries) {
          ;(byKind[entry.kind] ??= []).push(entry)
        }

        const kindLabels: Record<string, string> = {
          error_pattern: "Patterns d'erreurs récurrents",
          project_context: "Contexte du projet",
          user_preference: "Préférences détectées",
          episodic: "Épisodes d'exécution & Expérience",
          procedural: "Procédures & Recettes",
          semantic: "Contrats & Architecture",
        }

        const sections = Object.entries(byKind).map(([kind, items]) => {
          const label = kindLabels[kind] ?? kind
          const lines = items.map((e) => `- ${e.content}`).join("\n")
          return `### ${label}\n${lines}`
        })

        return `## 🧠 Mémoire adaptative (Hindsight)\n\n${sections.join("\n\n")}`
      })

    return Service.of({ record, retain, list, recall, reflect, remove, clear, render })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
