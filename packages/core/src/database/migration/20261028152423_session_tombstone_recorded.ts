import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028152423_session_tombstone_recorded",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_tombstone\` ADD \`time_recorded\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
