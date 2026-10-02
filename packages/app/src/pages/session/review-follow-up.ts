export type ReviewFollowUpScope = "turn" | "git" | "branch"

export type ReviewFollowUpComment = {
  file: string
  startLine: number
  endLine: number
  comment: string
}

const header = {
  turn: "Address these review comments on the last turn.",
  git: "Address these review comments on the unstaged diff.",
  branch: "Address these review comments on the branch diff.",
} as const

export function reviewFollowUp(input: { scope: ReviewFollowUpScope; comments: readonly ReviewFollowUpComment[] }) {
  const lines = input.comments.map(
    (comment) => `${comment.file}:${comment.startLine}-${comment.endLine}: ${comment.comment}`,
  )
  return [header[input.scope], ...lines].join("\n")
}
