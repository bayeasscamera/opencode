import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Creates the `memory` and `schedule` tables.
 *
 * This replaces the two hand-written migrations `20261001000000_memory_table` and
 * `20261001000001_schedule_table`, which never matched the generated schema: they omitted the
 * `project_id` foreign keys and declared `enabled` as `integer DEFAULT 1` instead of
 * `integer DEFAULT true`.
 *
 * The statements are `IF NOT EXISTS` because those two ids were already released on `dev`: a
 * database that ran them still lists them as completed and would otherwise fail here with
 * "table memory already exists" and refuse to open. Such a database keeps its original tables, so
 * it does not gain the foreign keys.
 */
export default {
  id: "20261001000000_memory_schedule_tables",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`memory\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`content\` text NOT NULL,
          \`source_session_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`schedule\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`cron\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`last_run_at\` integer,
          \`next_run_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_schedule_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`memory_project_kind_idx\` ON \`memory\` (\`project_id\`,\`kind\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`schedule_project_idx\` ON \`schedule\` (\`project_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
