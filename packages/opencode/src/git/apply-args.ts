export type ApplyIndex = "worktree" | "stage" | "unstage"

export function applyArgs(index: ApplyIndex = "worktree") {
  if (index === "stage") return ["apply", "--cached", "-"]
  if (index === "unstage") return ["apply", "--cached", "-R", "-"]
  return ["apply", "-"]
}
