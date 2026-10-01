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

  /** List all memories for a project, newest first. */
  readonly list: (project_id: ProjectV2.ID, kind?: MemoryKind) => Effect.Effect<MemoryEntry[]>

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

        const kindLabels: Record<MemoryKind, string> = {
          error_pattern: "Patterns d'erreurs récurrents",
          project_context: "Contexte du projet",
          user_preference: "Préférences détectées",
        }

        const sections = Object.entries(byKind).map(([kind, items]) => {
          const label = kindLabels[kind as MemoryKind] ?? kind
          const lines = items.map((e) => `- ${e.content}`).join("\n")
          return `### ${label}\n${lines}`
        })

        return `## 🧠 Mémoire persistante\n\n${sections.join("\n\n")}`
      })

    return Service.of({ record, list, remove, clear, render })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
