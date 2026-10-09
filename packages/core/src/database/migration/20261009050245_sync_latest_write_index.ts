import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261009050245_sync_latest_write_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`message_session_time_updated_idx\` ON \`message\` (\`session_id\`,\`time_updated\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_session_time_updated_idx\` ON \`part\` (\`session_id\`,\`time_updated\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_updated_idx\` ON \`session_message\` (\`session_id\`,\`time_updated\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
