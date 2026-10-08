import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008231637_add_session_folder",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_folder\` (
          \`session_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_folder_pk\` PRIMARY KEY(\`session_id\`, \`directory\`),
          CONSTRAINT \`fk_session_folder_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
