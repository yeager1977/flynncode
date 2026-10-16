import type { Hooks, PluginInput, ProviderUsage } from "@flynncode/plugin"

// Ollama's signed-in cloud usage API. Only 24h, 7d, and 30d ranges answer
// (others 400, and requesting too many windows too fast 429s), and the
// response carries request counts with no plan cap, so these windows report
// counts instead of utilization percents.
const USAGE_URL = "https://ollama.com/api/usage"
const USAGE_FETCH_TIMEOUT_MS = 10_000

export interface OllamaCloudUsageOptions {
  usageEndpoint?: string
  fetchImpl?: typeof fetch
}

type OllamaUsageBody = {
  range?: unknown
  until?: unknown
  totals?: unknown
}

type CountWindow = NonNullable<ProviderUsage["windows"][number]>

function countWindow(id: string, body: OllamaUsageBody | undefined): CountWindow | undefined {
  const count = (body?.totals as { request_count?: unknown } | undefined)?.request_count
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return undefined
  const until = typeof body?.until === "string" ? Date.parse(body.until) : Number.NaN
  return { id, count, ...(Number.isFinite(until) ? { resetsAt: until } : {}) }
}

export async function fetchOllamaUsage(input: {
  fetchImpl: typeof fetch
  token: string
  range: string
  windowID: string
  usageEndpoint?: string
}): Promise<CountWindow | undefined> {
  const base = input.usageEndpoint ?? USAGE_URL
  const url = `${base}?range=${encodeURIComponent(input.range)}`
  const res = await input
    .fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${input.token}` },
    })
    .catch(() => undefined)
  if (!res || !res.ok) return undefined
  const body = (await res.json().catch(() => undefined)) as OllamaUsageBody | undefined
  return countWindow(input.windowID, body)
}

export async function OllamaCloudUsagePlugin(_input: PluginInput, options: OllamaCloudUsageOptions = {}): Promise<Hooks> {
  return {
    auth: {
      provider: "ollama-cloud",
      methods: [],
      async usage(getAuth): Promise<ProviderUsage | undefined> {
        const auth = await getAuth()
        if (auth.type !== "api" || !auth.key) return undefined
        const fetchImpl = options.fetchImpl ?? fetch
        const windows = await Promise.all([
          fetchOllamaUsage({ fetchImpl, token: auth.key, range: "24h", windowID: "daily", usageEndpoint: options.usageEndpoint }),
          fetchOllamaUsage({ fetchImpl, token: auth.key, range: "30d", windowID: "monthly", usageEndpoint: options.usageEndpoint }),
        ])
        const result = windows.filter((window) => window !== undefined)
        if (result.length === 0) return undefined
        return { windows: result }
      },
    },
  }
}