import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261001000001_schedule_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`schedule\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`cron\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`enabled\` integer DEFAULT 1 NOT NULL,
          \`last_run_at\` integer,
          \`next_run_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`schedule_project_idx\` ON \`schedule\` (\`project_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
