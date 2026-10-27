export type HookTrustStatus = "managed" | "trusted" | "pending"

export type HookTrustSource = {
  hash: string
  event: string
  matcher: string
  summary: string
  trusted: boolean
  managed: boolean
  source?: string
}

export type HookTrustRow = {
  hash: string
  event: string
  matcher: string
  summary: string
  status: HookTrustStatus
  // The Claude Code source's label (or its id when it is no longer listed);
  // undefined for native hooks.
  source?: string
  sourceID?: string
}

export type ClaudeHookSource = {
  id: string
  kind: "user" | "project" | "plugin"
  label: string
  events: Array<string>
  commands: Array<string>
  enabled: boolean
  // Off through a project config's claude_hooks.disabled, which the switch
  // (it writes the global config) cannot turn back on.
  disabledByProject?: boolean
  warnings: Array<string>
}

export type ClaudeSourceRow = Omit<ClaudeHookSource, "root" | "disabledByProject"> & {
  pending: number
  disabledByProject: boolean
}

export function statusOf(entry: Pick<HookTrustSource, "trusted" | "managed">): HookTrustStatus {
  if (entry.managed) return "managed"
  if (entry.trusted) return "trusted"
  return "pending"
}

export function trustRows(
  entries: Array<HookTrustSource>,
  sources: ReadonlyArray<ClaudeHookSource> = [],
): Array<HookTrustRow> {
  const labels = new Map(sources.map((source) => [source.id, source.label]))
  return entries.map((entry) => ({
    hash: entry.hash,
    event: entry.event,
    matcher: entry.matcher,
    summary: entry.summary,
    status: statusOf(entry),
    source: entry.source === undefined ? undefined : (labels.get(entry.source) ?? entry.source),
    sourceID: entry.source,
  }))
}

export function claudeSourceRows(
  sources: ReadonlyArray<ClaudeHookSource>,
  rows: ReadonlyArray<HookTrustRow>,
): Array<ClaudeSourceRow> {
  return sources.map((source) => ({
    id: source.id,
    kind: source.kind,
    label: source.label,
    events: source.events,
    commands: source.commands,
    warnings: source.warnings,
    enabled: source.enabled,
    disabledByProject: source.disabledByProject === true,
    pending: rows.filter((row) => row.sourceID === source.id && row.status === "pending").length,
  }))
}

export function pendingCount(rows: Array<HookTrustRow>) {
  return rows.filter((row) => row.status === "pending").length
}
