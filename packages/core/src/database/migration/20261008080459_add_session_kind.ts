import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008080459_add_session_kind",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`kind\` text DEFAULT 'code' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
