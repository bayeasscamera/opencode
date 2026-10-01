import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"
import type { ProjectV2 } from "../project"
import type { SessionSchema } from "../session/schema"

/** Kinds of memories the system can record. */
export type MemoryKind =
  | "error_pattern"   // recurring errors and how they were fixed
  | "project_context" // key facts about the project
  | "user_preference" // observed coding preferences

export type MemoryID = string & { readonly _tag: "MemoryID" }

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().$type<MemoryID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    kind: text().$type<MemoryKind>().notNull(),
    content: text().notNull(),
    source_session_id: text().$type<SessionSchema.ID>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$onUpdate(() => Date.now()),
  },
  (table) => [index("memory_project_kind_idx").on(table.project_id, table.kind)],
)
