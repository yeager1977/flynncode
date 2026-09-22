import { emptyForm, type McpFormState } from "./mcp-payload"

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

const RUNNERS: Record<string, string> = { npm: "npx", pypi: "uvx" }

function packageCommand(pkg: Record<string, unknown>): string[] | undefined {
  const identifier = asString(pkg.identifier)
  const registryType = asString(pkg.registryType)
  if (!identifier || !registryType) return undefined
  const version = asString(pkg.version)
  if (registryType === "oci") {
    const flags = asArray(pkg.environmentVariables).flatMap((row) => {
      const name = asString(asRecord(row).name)
      if (!name) return []
      const value = asString(asRecord(row).default)
      return value === undefined ? ["-e", name] : ["-e", `${name}=${value}`]
    })
    return ["docker", "run", "-i", "--rm", ...flags, version ? `${identifier}:${version}` : identifier]
  }
  const hint = asString(pkg.runtimeHint)
  const runner = hint === "npx" || hint === "bunx" || hint === "uvx" ? hint : RUNNERS[registryType]
  if (!runner) return undefined
  const pinned = !version ? identifier : runner === "uvx" ? `${identifier}==${version}` : `${identifier}@${version}`
  const runtimeArgs = asArray(pkg.runtimeArguments).flatMap((row) => {
    const value = asString(asRecord(row).value)
    return value ? [value] : []
  })
  // npx/bunx already inject -y; drop duplicate flags from runtimeArguments.
  const extras = runner === "uvx" ? runtimeArgs : runtimeArgs.filter((arg) => arg !== "-y")
  return runner === "uvx" ? [runner, pinned, ...extras] : [runner, "-y", pinned, ...extras]
}

// "description · secret · required" — the description becomes the input
// placeholder; the flags tell the user what still needs a value.
function rowHint(record: Record<string, unknown>) {
  const flags = [
    record.isSecret === true ? "secret" : undefined,
    record.isRequired === true && asString(record.default) === undefined ? "required" : undefined,
  ].filter((flag) => flag !== undefined)
  const description = asString(record.description)
  if (description === undefined) return flags.join(" · ")
  return [description, ...flags].join(" · ")
}

function packageEnvironment(pkg: Record<string, unknown>) {
  return asArray(pkg.environmentVariables).flatMap((row) => {
    const record = asRecord(row)
    const name = asString(record.name)
    if (!name) return []
    return [{ key: name, value: asString(record.default) ?? "", hint: rowHint(record) }]
  })
}

function packageRequiredEnv(pkg: Record<string, unknown>) {
  return asArray(pkg.environmentVariables).flatMap((row) => {
    const record = asRecord(row)
    const name = asString(record.name)
    if (!name || record.isRequired !== true || asString(record.default) !== undefined) return []
    return [name]
  })
}

function remoteHeaders(remote: Record<string, unknown>) {
  return asArray(remote.headers).flatMap((row) => {
    const record = asRecord(row)
    const name = asString(record.name)
    const value = asString(record.value)
    if (!name) return []
    // A template like "Bearer {smithery_api_key}" is not a usable value.
    const usable = value !== undefined && !value.includes("{")
    return [{ key: name, value: usable ? value : "", hint: rowHint(record) }]
  })
}

function remoteRequiredHeaders(remote: Record<string, unknown>) {
  return asArray(remote.headers).flatMap((row) => {
    const record = asRecord(row)
    const name = asString(record.name)
    if (!name || record.isRequired !== true) return []
    const value = asString(record.value)
    return value !== undefined && !value.includes("{") ? [] : [name]
  })
}

export function toRegistryEntry(input: unknown, meta?: unknown): RegistryEntry | undefined {
  const raw = asRecord(input)
  const id = asString(raw.name)
  if (!id) return undefined
  const official = asRecord(asRecord(meta)[OFFICIAL_META])
  const status = asString(official.status) === "deprecated" ? ("deprecated" as const) : ("active" as const)
  const base = { id, title: id.slice(id.lastIndexOf("/") + 1), description: asString(raw.description) ?? "", version: asString(raw.version), status }
  const pkg = asArray(raw.packages).map(asRecord).find((candidate) => packageCommand(candidate) !== undefined)
  if (pkg) {
    return {
      ...base,
      transport: "stdio",
      local: { command: packageCommand(pkg) ?? [], environment: packageEnvironment(pkg), requiredEnv: packageRequiredEnv(pkg) },
    }
  }
  const remote = asArray(raw.remotes).map(asRecord).find((candidate) => asString(candidate.url) !== undefined)
  if (remote) {
    return {
      ...base,
      transport: "remote",
      remote: { url: asString(remote.url) ?? "", headers: remoteHeaders(remote), requiredHeaders: remoteRequiredHeaders(remote) },
    }
  }
  return { ...base, transport: "unsupported" }
}

function uniqueName(base: string, taken: string[]) {
  if (!taken.includes(base)) return base
  let index = 2
  while (taken.includes(`${base}-${index}`)) index++
  return `${base}-${index}`
}

export function registryToForm(entry: RegistryEntry, opts: { existingNames: string[] }): { form: McpFormState; noteVars: string[] } {
  const form = emptyForm(uniqueName(entry.title, opts.existingNames))
  if (entry.local) {
    form.kind = "local"
    form.command = [...entry.local.command]
    form.environment = entry.local.environment.map((row) => ({ ...row }))
    return { form, noteVars: entry.local.requiredEnv }
  }
  form.kind = "remote"
  form.url = entry.remote?.url ?? ""
  form.headers = (entry.remote?.headers ?? []).map((row) => ({ ...row }))
  return { form, noteVars: entry.remote?.requiredHeaders ?? [] }
}
