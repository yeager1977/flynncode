import type { Model } from "@flynncode/sdk/v2"
import { describe, expect, test } from "bun:test"
import { OllamaCloudUsagePlugin, fetchOllamaUsage } from "../../src/plugin/ollama-cloud"

describe("plugin.ollama-cloud", () => {
  describe("fetchOllamaUsage", () => {
    test("maps request counts to count windows", async () => {
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({
            range: "24h",
            from: "2026-10-15T00:00:00Z",
            until: "2026-10-16T14:00:00Z",
            totals: { request_count: 2364 },
            buckets: [],
          }),
        )) as unknown as typeof fetch
      const window = await fetchOllamaUsage({ fetchImpl, token: "t", range: "24h", windowID: "daily" })
      expect(window).toEqual({ id: "daily", count: 2364, resetsAt: Date.parse("2026-10-16T14:00:00Z") })
    })

    test("uses the configured endpoint and carries the range as a query parameter", async () => {
      let seen: string | undefined
      const fetchImpl = (async (url: string | URL) => {
        seen = String(url)
        return new Response(
          JSON.stringify({ range: "30d", until: "2026-10-16T14:00:00Z", totals: { request_count: 211180 } }),
        )
      }) as unknown as typeof fetch
      const window = await fetchOllamaUsage({
        fetchImpl,
        token: "t",
        range: "30d",
        windowID: "monthly",
        usageEndpoint: "https://stub.localhost/api/usage",
      })
      expect(seen).toBe("https://stub.localhost/api/usage?range=30d")
      expect(window).toEqual({ id: "monthly", count: 211180, resetsAt: Date.parse("2026-10-16T14:00:00Z") })
    })

    test("returns undefined on failures and unusable totals", async () => {
      const denied = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch
      expect(await fetchOllamaUsage({ fetchImpl: denied, token: "t", range: "1h", windowID: "daily" })).toBeUndefined()

      const empty = (async () => new Response(JSON.stringify({ range: "7d", totals: {} }))) as unknown as typeof fetch
      expect(await fetchOllamaUsage({ fetchImpl: empty, token: "t", range: "7d", windowID: "daily" })).toBeUndefined()

      const broken = (async () => new Response("<not json")) as unknown as typeof fetch
      expect(await fetchOllamaUsage({ fetchImpl: broken, token: "t", range: "7d", windowID: "daily" })).toBeUndefined()
    })
  })

  test("usage hook aggregates daily and monthly count windows for api-key auth", async () => {
    const fetchImpl = (async (url: string | URL) =>
      new Response(
        JSON.stringify({
          range: String(new URL(String(url)).searchParams.get("range")),
          until: "2026-10-16T14:00:00Z",
          totals: { request_count: 42 },
        }),
      )) as unknown as typeof fetch
    const plugin = await OllamaCloudUsagePlugin({} as never, { usageEndpoint: "https://stub.localhost/api/usage", fetchImpl })
    const usage = await plugin.auth?.usage?.(async () => ({ type: "api", key: "k" }) as never)
    expect(usage?.windows).toEqual([
      { id: "daily", count: 42, resetsAt: Date.parse("2026-10-16T14:00:00Z") },
      { id: "monthly", count: 42, resetsAt: Date.parse("2026-10-16T14:00:00Z") },
    ])
  })

  test("usage hook is omitted for non-api credentials", async () => {
    const plugin = await OllamaCloudUsagePlugin({} as never, {})
    const usage = await plugin.auth?.usage?.(async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }) as never)
    expect(usage).toBeUndefined()
  })
})
describe("plugin.ollama-cloud provider models hook", () => {
  const catalogModel: Model = {
    id: "glm-5.3-flash",
    providerID: "ollama-cloud",
    name: "GLM 5.3 Flash",
    api: { id: "glm-5.3-flash", url: "https://ollama.com/v1", npm: "@ai-sdk/openai-compatible" },
    family: "glm",
    status: "active",
    headers: {},
    options: {},
    cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
    limit: { context: 1000, input: undefined, output: 100 },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "2026-09-11",
    variants: {},
  }

  const provider = { models: { "glm-5.3-flash": catalogModel } } as never

  test("merges newly added cloud models into the catalog", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "glm-5.3-flash", capabilities: ["completion", "tools"] },
            { name: "beam", capabilities: ["completion", "thinking", "tools"] },
          ],
        }),
      )) as unknown as typeof fetch
    const plugin = await OllamaCloudUsagePlugin({} as never, { fetchImpl })
    const models = await plugin.provider?.models?.(provider, { auth: { type: "api", key: "k" } } as never)
    const additions = Object.keys(models ?? {})
    expect(additions).toEqual(["glm-5.3-flash", "beam"])
    const beam = models?.["beam"]
    expect(beam?.name).toBe("beam")
    expect(beam?.api).toEqual({ id: "beam", url: "https://ollama.com/v1", npm: "@ai-sdk/openai-compatible" })
    expect(beam?.capabilities.toolcall).toBe(true)
    expect(beam?.capabilities.reasoning).toBe(true)
    // Existing catalog entries keep their identity and pricing.
    expect(models?.["glm-5.3-flash"]).toBe(catalogModel)
  })

  test("keeps the catalog on failures and short polls", async () => {
    const denied = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch
    const plugin = await OllamaCloudUsagePlugin({} as never, { fetchImpl: denied })
    const models = await plugin.provider?.models?.(provider, { auth: { type: "api", key: "k" } } as never)
    expect(Object.keys(models ?? {})).toEqual(["glm-5.3-flash"])

    const empty = (async () => new Response(JSON.stringify({ models: [] }))) as unknown as typeof fetch
    const plugin2 = await OllamaCloudUsagePlugin({} as never, { fetchImpl: empty })
    const models2 = await plugin2.provider?.models?.(provider, { auth: { type: "api", key: "k" } } as never)
    expect(Object.keys(models2 ?? {})).toEqual(["glm-5.3-flash"])
  })

  test("skips polling without api credentials", async () => {
    const plugin = await OllamaCloudUsagePlugin({} as never, {})
    const models = await plugin.provider?.models?.(provider, {} as never)
    expect(Object.keys(models ?? {})).toEqual(["glm-5.3-flash"])
  })
})
