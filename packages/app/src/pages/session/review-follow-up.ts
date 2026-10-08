export type ReviewFollowUpComment = {
  file: string
  startLine: number
  endLine: number
  comment: string
}

export function reviewFollowUp(input: { header: string; comments: readonly ReviewFollowUpComment[] }) {
  const lines = input.comments.map(
    (comment) => `${comment.file}:${comment.startLine}-${comment.endLine}: ${comment.comment}`,
  )
  return [input.header, ...lines].join("\n")
}
