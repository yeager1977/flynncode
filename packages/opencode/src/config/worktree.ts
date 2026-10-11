export * as ConfigWorktree from "./worktree"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

const DEFAULT_LOCATION = ".opencode/worktrees"
const DEFAULT_BRANCH_PREFIX = "opencode"
const DEFAULT_KEEP = 15

export type Settings = {
  location: string
  branchPrefix: string
  keep: number
  allowPrimaryRebind: boolean
}

// config.worktree is tolerant like model_family: the schema keeps plain
// optional fields and validation happens here, so unknown or malformed values
// degrade to defaults instead of failing config load.
export function settings(config: ConfigV1.Info | undefined): Settings {
  const raw = isRecord(config?.worktree) ? (config?.worktree as Record<string, unknown>) : {}
  return {
    location: typeof raw.location === "string" && raw.location.trim() !== "" ? raw.location : DEFAULT_LOCATION,
    branchPrefix:
      typeof raw.branch_prefix === "string" && raw.branch_prefix.trim() !== ""
        ? raw.branch_prefix.trim().replace(/\/+$/, "")
        : DEFAULT_BRANCH_PREFIX,
    keep: typeof raw.keep === "number" && Number.isInteger(raw.keep) && raw.keep >= 0 ? raw.keep : DEFAULT_KEEP,
    // Strict boolean: only the literal true enables rebind-on-handoff.
    allowPrimaryRebind: raw.allow_primary_rebind === true,
  }
}

export const defaults = {
  location: DEFAULT_LOCATION,
  branchPrefix: DEFAULT_BRANCH_PREFIX,
  keep: DEFAULT_KEEP,
  allowPrimaryRebind: false,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}