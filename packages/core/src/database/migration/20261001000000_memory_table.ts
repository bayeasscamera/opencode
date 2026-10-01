import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261001000000_memory_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`content\` text NOT NULL,
          \`source_session_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_project_kind_idx\` ON \`memory\` (\`project_id\`, \`kind\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
