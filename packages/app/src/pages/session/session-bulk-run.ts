export type BulkOp = "archive" | "delete"

export type BulkRunInput = {
  ids: readonly string[]
  op: BulkOp
  isProtected: (id: string) => boolean
  archive: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export type BulkRunResult = {
  done: string[]
  failed?: string
  pending: string[]
  skipped: string[]
}

export async function runSessionBulk(input: BulkRunInput): Promise<BulkRunResult> {
  const done: string[] = []
  const skipped: string[] = []
  // A caller that cancels mid-run throws from its callbacks; treat that as a
  // stop, not a failure, so the pending tail is reported without an error.
  for (let index = 0; index < input.ids.length; index++) {
    const id = input.ids[index]
    if (!id) continue
    try {
      if (input.isProtected(id)) {
        skipped.push(id)
        continue
      }
      if (input.op === "archive") await input.archive(id)
      else await input.remove(id)
      done.push(id)
    } catch (error) {
      const cancelled = error instanceof Error && error.message === "cancelled"
      return { done, failed: cancelled ? undefined : id, pending: input.ids.slice(index + 1), skipped }
    }
  }
  return { done, pending: [], skipped }
}
