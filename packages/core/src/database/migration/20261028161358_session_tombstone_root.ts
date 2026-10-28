import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028161358_session_tombstone_root",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_tombstone\` ADD \`root_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
