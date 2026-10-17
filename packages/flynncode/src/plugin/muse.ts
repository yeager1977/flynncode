import type { Model as ModelV2 } from "@flynncode/sdk/v2"
import type { Hooks, PluginInput } from "@flynncode/plugin"

// Meta's OpenAI-compatible catalog endpoint. The vendored models.dev snapshot
// lags new muse/meta releases (a muse account list grows between catalog
// updates), so the provider hook polls the live list at every provider state
// rebuild and merges unknown ids in.
const MODELS_URL = "https://api.meta.ai/v1/models"
const NPM = "@ai-sdk/openai"
const FETCH_TIMEOUT_MS = 10_000

export interface MuseOptions {
  modelsEndpoint?: string
  fetchImpl?: typeof fetch
}

type MetaModelsBody = {
  data?: Array<{ id?: unknown; object?: unknown; created?: unknown }>
}

export async function fetchMetaModels(input: {
  fetchImpl: typeof fetch
  token: string
  modelsEndpoint?: string
}): Promise<Array<{ id: string; created?: number }> | undefined> {
  const res = await input
    .fetchImpl(input.modelsEndpoint ?? MODELS_URL, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${input.token}` },
    })
    .catch(() => undefined)
  if (!res || !res.ok) return undefined
  const body = (await res.json().catch(() => undefined)) as MetaModelsBody | undefined
  const models = body?.data
  if (!Array.isArray(models)) return undefined
  const out: Array<{ id: string; created?: number }> = []
  for (const model of models) {
    if (typeof model?.id !== "string" || model.id === "") continue
    // 0 means "unknown" in this api; new Date(0) would read as 1970.
    out.push({
      id: model.id,
      ...(typeof model.created === "number" && Number.isFinite(model.created) && model.created > 0
        ? { created: model.created }
        : {}),
    })
  }
  return out
}

// Same minimal shape the server's discovery uses for unknown ids; the SDK
// package for meta models is the openai one the catalog already wires.
function stubModel(input: { id: string; npm: string; baseURL: string; created?: number }): Omit<ModelV2, "id" | "providerID"> {
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
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: input.created ? new Date(input.created * 1000).toISOString().slice(0, 10) : "",
    variants: {},
  } as Omit<ModelV2, "id" | "providerID">
}

export async function MusePlugin(_input: PluginInput, options: MuseOptions = {}): Promise<Hooks> {
  const fetchImpl = () => options.fetchImpl ?? fetch
  return {
    provider: {
      id: "meta",
      async models(provider, ctx) {
        const base = provider.models ?? {}
        const auth = ctx.auth
        if (auth?.type !== "api" || !auth.key) return base
        const found = await fetchMetaModels({ fetchImpl: fetchImpl(), token: auth.key, modelsEndpoint: options.modelsEndpoint })
        if (!found || found.length === 0) return base
        // Catalog entries keep their pricing/limits; new entries copy the
        // catalog's endpoint and SDK wiring so they route the same way.
        const wired = Object.values(base).find((model) => typeof model?.api?.url === "string" && model.api.url.startsWith("https://"))
        const baseURL = wired?.api.url ?? "https://api.meta.ai/v1"
        const out = { ...base }
        for (const model of found) {
          if (out[model.id]) continue
          out[model.id] = {
            ...stubModel({ id: model.id, npm: wired?.api.npm ?? NPM, baseURL, created: model.created }),
          } as ModelV2
        }
        return out
      },
    },
  }
}