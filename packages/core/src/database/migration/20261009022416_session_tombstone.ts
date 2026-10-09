import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261009022416_session_tombstone",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tombstone\` (
          \`id\` text PRIMARY KEY,
          \`time_deleted\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
