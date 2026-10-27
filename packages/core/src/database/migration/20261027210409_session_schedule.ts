import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261027210409_session_schedule",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_schedule\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`cron\` text,
          \`prompt\` text NOT NULL,
          \`reason\` text,
          \`recurring\` integer NOT NULL,
          \`next_run_at\` integer NOT NULL,
          \`expires_at\` integer,
          \`lease_until\` integer,
          \`failures\` integer DEFAULT 0 NOT NULL,
          \`pending_message_id\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_schedule_session_idx\` ON \`session_schedule\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_schedule_next_run_idx\` ON \`session_schedule\` (\`next_run_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
