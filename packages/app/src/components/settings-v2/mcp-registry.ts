export type RegistryEntry = {
  id: string // reverse-DNS name, e.g. "io.github.user/filesystem"
  title: string // last path segment of id
  description: string
  version?: string
  status: "active" | "deprecated"
  // "unsupported" = named entry with no mappable package or remote. Shown in
  // results with a disabled Configure button (spec: disable Select with an
  // explanation) instead of being dropped.
  transport: "stdio" | "remote" | "unsupported"
  local?: { command: string[]; environment: { key: string; value: string; hint?: string }[]; requiredEnv: string[] }
  remote?: { url: string; headers: { key: string; value: string; hint?: string }[]; requiredHeaders: string[] }
}

const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers"
const OFFICIAL_META = "io.modelcontextprotocol.registry/official"

export function buildRegistryUrl(query: { search?: string; cursor?: string }) {
  const params = new URLSearchParams({ limit: "30" })
  if (query.search) params.set("search", query.search)
  if (query.cursor) params.set("cursor", query.cursor)
  return `${REGISTRY_URL}?${params.toString()}`
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

export function parseRegistryList(json: unknown) {
  const raw = asRecord(json)
  const seen = new Map<string, { entry: RegistryEntry; isLatest: boolean }>()
  for (const row of asArray(raw.servers)) {
    const outer = asRecord(row)
    const meta = asRecord(asRecord(outer._meta)[OFFICIAL_META])
    const entry = toRegistryEntry(outer.server, outer._meta)
    if (!entry) continue
    const isLatest = meta.isLatest === true
    const current = seen.get(entry.id)
    // The API returns one row per published version; keep the latest.
    if (current?.isLatest) continue
    seen.set(entry.id, { entry, isLatest })
  }
  return { entries: [...seen.values()].map((row) => row.entry), nextCursor: asString(asRecord(raw.metadata).nextCursor) }
}

export async function searchRegistry(query: { search?: string; cursor?: string }) {
  const response = await fetch(buildRegistryUrl(query), { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`registry ${response.status}`)
  return parseRegistryList(await response.json())
}

// Task 1 ships the minimal stub parse needs: named rows become
// "unsupported" entries so dedupe/pagination work end to end. The full
// packages/remotes mapping replaces this body in Task 2.
export function toRegistryEntry(input: unknown, meta?: unknown): RegistryEntry | undefined {
  const raw = asRecord(input)
  const id = asString(raw.name)
  if (!id) return undefined
  const official = asRecord(asRecord(meta)[OFFICIAL_META])
  const status = asString(official.status) === "deprecated" ? ("deprecated" as const) : ("active" as const)
  return {
    id,
    title: id.slice(id.lastIndexOf("/") + 1),
    description: asString(raw.description) ?? "",
    version: asString(raw.version),
    status,
    transport: "unsupported",
  }
}