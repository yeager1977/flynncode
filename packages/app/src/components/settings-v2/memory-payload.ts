import type { Config } from "@flynncode/sdk/v2/client"

// Mirror of ConfigMemoryV1.defaults (packages/core/src/v1/config/memory.ts):
// the server decodes unset fields to these values, so the UI shows — and a
// save persists — exactly what the server resolves.
export const MEMORY_DEFAULTS = { enabled: false, min_turns: 4 } as const

export type MemoryPatch = { enabled: boolean } | { min_turns: number }

export function memoryFromConfig(config: Config | undefined) {
  const memory = config?.memory
  return {
    enabled: memory?.enabled ?? MEMORY_DEFAULTS.enabled,
    minTurns: memory?.min_turns ?? MEMORY_DEFAULTS.min_turns,
  }
}

// The server swaps config subtrees at write sites, so the patch carries the
// full current `memory` block — max_files and max_chars_per_file never drop
// when only the toggle or min_turns changes.
export function memoryToConfig(current: Config["memory"], patch: MemoryPatch): Config["memory"] {
  return { ...current, ...patch }
}

export function minTurnsFromInput(text: string) {
  // No UI upper bound: the server schema (ConfigMemoryV1.min_turns is
  // NonNegativeInt) stays the authority, and a very large value only means
  // memory extraction rarely triggers — a harmless user choice.
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  return Number(trimmed)
}
