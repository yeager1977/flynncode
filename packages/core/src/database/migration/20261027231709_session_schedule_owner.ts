import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261027231709_session_schedule_owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_schedule\` ADD \`owner\` text DEFAULT 'sidecar' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
