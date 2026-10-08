export type RelayInboxItem = {
  sessionID: string
  directory: string | undefined
  title: string
  kind: "permission" | "question"
  updated: number
}

export type RelayDigestBody = {
  originID: string
  items: RelayInboxItem[]
  updatedAt: number
}

// The digest carries session metadata only (sessionID, title, directory,
// kind, updated) — never prompt text, file contents, passwords, or tokens.
export function buildDigestBody(input: { originID: string; items: RelayInboxItem[]; updatedAt: number }): RelayDigestBody {
  return {
    originID: input.originID,
    items: input.items.map((item) => ({
      sessionID: item.sessionID,
      directory: item.directory,
      title: item.title,
      kind: item.kind,
      updated: item.updated,
    })),
    updatedAt: input.updatedAt,
  }
}

export function generateRelayToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const POLL_MS = 60_000
const TIMEOUT_MS = 5000

export function startRelayPublisher(input: {
  originID: string
  pollMs?: number
  localInboxUrl: string
  remotePublishUrl: string
  username?: string
  phonePassword: string
  relayToken: string
  fetchImpl?: typeof fetch
}): { stop(): void } {
  const fetchImpl = input.fetchImpl ?? fetch
  const username = input.username ?? "opencode"
  let publishedNonEmpty = false
  let stopped = false

  async function tick() {
    if (stopped) return
    const items = await loadInbox()
    if (items === undefined) return
    if (items.length === 0 && !publishedNonEmpty) return
    const ok = await publish(items)
    if (ok) publishedNonEmpty = items.length > 0
  }

  async function loadInbox(): Promise<RelayInboxItem[] | undefined> {
    try {
      const response = await fetchImpl(input.localInboxUrl, {
        headers: { authorization: `Basic ${Buffer.from(`${username}:${input.phonePassword}`).toString("base64")}` },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        console.warn(`[relay-publisher] local inbox answered ${response.status}`)
        return
      }
      return parseInbox(await response.json())
    } catch (error) {
      console.warn(`[relay-publisher] local inbox unreachable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
  }

  async function publish(items: RelayInboxItem[]) {
    try {
      const response = await fetchImpl(input.remotePublishUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${input.relayToken}`, "content-type": "application/json" },
        body: JSON.stringify(buildDigestBody({ originID: input.originID, items, updatedAt: Date.now() })),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        console.warn(`[relay-publisher] remote publish answered ${response.status}`)
        return false
      }
      return true
    } catch (error) {
      console.warn(`[relay-publisher] remote publish unreachable: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  const timer = setInterval(() => void tick(), input.pollMs ?? POLL_MS)
  void tick()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseInbox(value: unknown): RelayInboxItem[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return
  const items: RelayInboxItem[] = []
  for (const entry of value.items) {
    if (!isRecord(entry)) return
    if (typeof entry.sessionID !== "string" || !entry.sessionID) return
    if (typeof entry.title !== "string") return
    if (typeof entry.updated !== "number" || !Number.isFinite(entry.updated)) return
    if (entry.kind !== "permission" && entry.kind !== "question") return
    items.push({
      sessionID: entry.sessionID,
      directory: typeof entry.directory === "string" ? entry.directory : undefined,
      title: entry.title,
      kind: entry.kind,
      updated: entry.updated,
    })
  }
  return items
}
