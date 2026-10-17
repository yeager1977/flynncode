import type { Model as ModelV2 } from "@flynncode/sdk/v2"
import type { Hooks, PluginInput, ProviderUsage } from "@flynncode/plugin"

// Ollama's signed-in cloud usage API. Only 24h, 7d, and 30d ranges answer
// (others 400, and requesting too many windows too fast 429s), and the
// response carries request counts with no plan cap, so these windows report
// counts instead of utilization percents.
const USAGE_URL = "https://ollama.com/api/usage"
// The account's cloud model list; the vendored models.dev snapshot ages out
// between ollama.com releases, and the models.dev api-url check skips
// discovery for this provider, so the hook polls the live account list.
const TAGS_URL = "https://ollama.com/api/tags"
const FETCH_TIMEOUT_MS = 10_000

export interface OllamaCloudUsageOptions {
  usageEndpoint?: string
  tagsEndpoint?: string
  fetchImpl?: typeof fetch
}

type OllamaUsageBody = {
  range?: unknown
  until?: unknown
  totals?: unknown
}

type OllamaTagBody = {
  models?: Array<{ name?: unknown; capabilities?: unknown }>
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${input.token}` },
    })
    .catch(() => undefined)
  if (!res || !res.ok) return undefined
  const body = (await res.json().catch(() => undefined)) as OllamaUsageBody | undefined
  return countWindow(input.windowID, body)
}

// The account's cloud models with their capabilities. Empty on any failure so
// callers keep the installed catalog.
export type OllamaCloudModel = { id: string; name: string; tools: boolean; reasoning: boolean }

export async function fetchOllamaCloudModels(input: {
  fetchImpl: typeof fetch
  token: string
  tagsEndpoint?: string
}): Promise<OllamaCloudModel[] | undefined> {
  const res = await input
    .fetchImpl(input.tagsEndpoint ?? TAGS_URL, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${input.token}` },
    })
    .catch(() => undefined)
  if (!res || !res.ok) return undefined
  const body = (await res.json().catch(() => undefined)) as OllamaTagBody | undefined
  const models = body?.models
  if (!Array.isArray(models)) return undefined
  const out: OllamaCloudModel[] = []
  for (const model of models) {
    if (typeof model?.name !== "string" || model.name === "") continue
    const capabilities = Array.isArray(model.capabilities)
      ? model.capabilities.filter((capability): capability is string => typeof capability === "string")
      : []
    out.push({
      id: model.name,
      name: model.name,
      tools: capabilities.includes("tools"),
      reasoning: capabilities.includes("thinking"),
    })
  }
  return out
}

// The minimal model entry shape the server's openai-compatible discovery
// builds for unknown ids. Endpoint and SDK route default to ollama.com's
// public api, matching how the vendored catalog entries are wired.
function stubModel(input: {
  id: string
  npm: string
  baseURL: string
  tools: boolean
  reasoning: boolean
}): Omit<ModelV2, "id" | "providerID"> {
  return {
    name: input.id,
    api: { id: input.id, url: input.baseURL, npm: input.npm },
    family: "",
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, input: undefined, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: input.reasoning,
      attachment: false,
      toolcall: input.tools,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  } as Omit<ModelV2, "id" | "providerID">
}

export async function OllamaCloudUsagePlugin(_input: PluginInput, options: OllamaCloudUsageOptions = {}): Promise<Hooks> {
  const fetchImpl = () => options.fetchImpl ?? fetch
  return {
    // The live account model list merged over the vendored catalog so newly
    // released ollama.com cloud models (checked at every provider state
    // rebuild) are selectable and routable without a models.dev refresh.
    provider: {
      id: "ollama-cloud",
      async models(provider, ctx) {
        const base = provider.models ?? {}
        const auth = ctx.auth
        if (auth?.type !== "api" || !auth.key) return base
        const found = await fetchOllamaCloudModels({ fetchImpl: fetchImpl(), token: auth.key, tagsEndpoint: options.tagsEndpoint })
        if (!found || found.length === 0) return base
        // Catalog entries keep their pricing/limits; the endpoint and SDK
        // route for new entries copy the wired catalog shape.
        const wired = Object.values(base).find((model) => typeof model?.api?.url === "string" && model.api.url.startsWith("https://"))
        const baseURL = wired?.api.url ?? "https://ollama.com/v1"
        const out = { ...base }
        for (const model of found) {
          if (out[model.id]) continue
          out[model.id] = {
            ...stubModel({ id: model.id, npm: wired?.api.npm ?? "@ai-sdk/openai-compatible", baseURL, tools: model.tools, reasoning: model.reasoning }),
          } as ModelV2
        }
        return out
      },
    },
    auth: {
      provider: "ollama-cloud",
      methods: [],
      async usage(getAuth): Promise<ProviderUsage | undefined> {
        const auth = await getAuth()
        if (auth.type !== "api" || !auth.key) return undefined
        const windows = await Promise.all([
          fetchOllamaUsage({ fetchImpl: fetchImpl(), token: auth.key, range: "24h", windowID: "daily", usageEndpoint: options.usageEndpoint }),
          fetchOllamaUsage({ fetchImpl: fetchImpl(), token: auth.key, range: "30d", windowID: "monthly", usageEndpoint: options.usageEndpoint }),
        ])
        const result = windows.filter((window) => window !== undefined)
        if (result.length === 0) return undefined
        return { windows: result }
      },
    },
  }
}