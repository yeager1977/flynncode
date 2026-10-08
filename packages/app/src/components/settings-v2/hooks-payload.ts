export type HookTrustStatus = "managed" | "trusted" | "pending"

export type HookTrustSource = {
  hash: string
  event: string
  matcher: string
  summary: string
  trusted: boolean
  managed: boolean
}

export type HookTrustRow = {
  hash: string
  event: string
  matcher: string
  summary: string
  status: HookTrustStatus
}

export function statusOf(entry: Pick<HookTrustSource, "trusted" | "managed">): HookTrustStatus {
  if (entry.managed) return "managed"
  if (entry.trusted) return "trusted"
  return "pending"
}

export function trustRows(entries: Array<HookTrustSource>): Array<HookTrustRow> {
  return entries.map((entry) => ({
    hash: entry.hash,
    event: entry.event,
    matcher: entry.matcher,
    summary: entry.summary,
    status: statusOf(entry),
  }))
}

export function pendingCount(rows: Array<HookTrustRow>) {
  return rows.filter((row) => row.status === "pending").length
}
