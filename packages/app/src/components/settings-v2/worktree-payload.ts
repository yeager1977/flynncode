import type { Config } from "@opencode-ai/sdk/v2/client"

export type WorktreeForm = {
  location: string
  branchPrefix: string
  keep: string
}

const emptyForm = (): WorktreeForm => ({ location: "", branchPrefix: "", keep: "" })

export function worktreeFromConfig(config: Config | undefined): WorktreeForm {
  const raw = config?.worktree as { location?: unknown; branch_prefix?: unknown; keep?: unknown } | undefined
  return {
    location: typeof raw?.location === "string" ? raw.location : "",
    branchPrefix: typeof raw?.branch_prefix === "string" ? raw.branch_prefix : "",
    keep: typeof raw?.keep === "number" ? String(raw.keep) : "",
  }
}

export function worktreeHasConfig(config: Config | undefined): boolean {
  return Boolean((config?.worktree as unknown) !== undefined)
}

// Empty fields stay absent so a save only writes what the user set. The server
// replaces `worktree` as a whole and removes it when the object is empty, so
// clearing every field still persists.
export function worktreeToConfig(form: WorktreeForm): { worktree: NonNullable<Config["worktree"]> } {
  const location = form.location.trim()
  const branchPrefix = form.branchPrefix.trim()
  const keep = worktreeKeepValue(form)
  return {
    worktree: {
      ...(location ? { location } : {}),
      ...(branchPrefix ? { branch_prefix: branchPrefix } : {}),
      ...(keep !== undefined ? { keep } : {}),
    },
  }
}

export function worktreeKeepValue(form: WorktreeForm): number | undefined {
  const text = form.keep.trim()
  if (!text) return undefined
  const parsed = Number(text)
  if (!Number.isInteger(parsed) || parsed < 0) return undefined
  return parsed
}

export function worktreeValidationErrors(form: WorktreeForm): Array<"keep" | "location"> {
  const errors: Array<"keep" | "location"> = []
  const text = form.keep.trim()
  if (text && worktreeKeepValue(form) === undefined) errors.push("keep")
  if (form.location.trim().startsWith("~")) errors.push("location")
  return errors
}

export const emptyWorktreeForm = emptyForm