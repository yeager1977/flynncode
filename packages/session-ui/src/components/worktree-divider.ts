import { getFilename } from "@flynncode/core/util/path"

export type WorktreeDivider = {
  key:
    | "ui.tool.worktree.entered"
    | "ui.tool.worktree.exited.kept"
    | "ui.tool.worktree.exited.removed"
    | "ui.tool.worktree.exited.pending"
  params: Record<string, string>
}

/** Describes a worktree switch from the tool part's `metadata.worktree` for the compact divider. */
export function worktreeDivider(metadata: Record<string, unknown>): WorktreeDivider | undefined {
  const value = metadata["worktree"]
  if (typeof value !== "object" || value === null) return undefined
  const fields: Record<string, unknown> = { ...value }
  const path = typeof fields["path"] === "string" ? fields["path"] : ""
  if (path === "") return undefined
  if (fields["action"] === "enter") {
    const branch =
      typeof fields["branch"] === "string" && fields["branch"] !== "" ? fields["branch"] : getFilename(path)
    return { key: "ui.tool.worktree.entered", params: { branch } }
  }
  if (fields["action"] !== "exit") return undefined
  const folder = getFilename(path)
  if (fields["pending"] === true) return { key: "ui.tool.worktree.exited.pending", params: { folder } }
  return {
    key: fields["removed"] === true ? "ui.tool.worktree.exited.removed" : "ui.tool.worktree.exited.kept",
    params: { folder },
  }
}
