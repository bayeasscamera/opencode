import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"
import type { ProjectV2 } from "../project"

export type ScheduleID = string & { readonly _tag: "ScheduleID" }

export const ScheduleTable = sqliteTable(
  "schedule",
  {
    id: text().$type<ScheduleID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    cron: text().notNull(),
    prompt: text().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    last_run_at: integer(),
    next_run_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$onUpdate(() => Date.now()),
  },
  (table) => [index("schedule_project_idx").on(table.project_id)],
)
