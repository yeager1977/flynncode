import { reversePatch } from "./hunk-revert"

export type HunkIndex = "worktree" | "stage" | "unstage"
export type ReviewScope = "git" | "branch" | "turn"

export function reviewIndexActions(scope: ReviewScope) {
  return scope === "git"
}

export function hunkApply(input: { patch: string; index?: HunkIndex; revert?: boolean }) {
  if (input.revert) return { patch: reversePatch(input.patch) }
  return { patch: input.patch, index: input.index }
}

export type HunkApplyCall = ReturnType<typeof hunkApply>

export async function applyHunkSequence(
  calls: readonly HunkApplyCall[],
  apply: (call: HunkApplyCall) => Promise<unknown>,
) {
  for (const call of calls) await apply(call)
}

export function whenApplied<T>(pending: Promise<T>, onApplied?: () => void) {
  return pending.then((value) => {
    onApplied?.()
    return value
  })
}
