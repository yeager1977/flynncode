export * as ConfigMemoryV1 from "./memory"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable on-disk agent memories. Off by default; memories are local files and are never synced.",
  }),
  min_turns: Schema.optional(NonNegativeInt).annotate({
    description: "Sessions with fewer user turns than this are skipped for memory extraction (default: 4).",
  }),
  max_files: Schema.optional(PositiveInt).annotate({
    description: "Maximum memory files read into context per session (default: 20).",
  }),
  max_chars_per_file: Schema.optional(PositiveInt).annotate({
    description: "Per-file character cap when loading memories into context (default: 4000).",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>

export const defaults = {
  enabled: false,
  min_turns: 4,
  max_files: 20,
  max_chars_per_file: 4000,
} as const

export function resolved(input: Info) {
  return {
    enabled: input.enabled ?? defaults.enabled,
    min_turns: input.min_turns ?? defaults.min_turns,
    max_files: input.max_files ?? defaults.max_files,
    max_chars_per_file: input.max_chars_per_file ?? defaults.max_chars_per_file,
  }
}
