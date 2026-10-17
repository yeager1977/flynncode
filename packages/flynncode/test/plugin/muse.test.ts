import type { Model } from "@flynncode/sdk/v2"
import { describe, expect, test } from "bun:test"
import { MusePlugin, fetchMetaModels } from "../../src/plugin/muse"

const catalogModel: Model = {
  id: "muse-spark-1.1",
  providerID: "meta",
  name: "Muse Spark 1.1",
  api: { id: "muse-spark-1.1", url: "https://api.meta.ai/v1", npm: "@ai-sdk/openai" },
  family: "muse",
  status: "active",
  headers: {},
  options: {},
  cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
  limit: { context: 1048576, input: undefined, output: 100 },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "2026-09-01",
  variants: {},
}
const provider = { models: { "muse-spark-1.1": catalogModel } } as never

describe("plugin.muse", () => {
  test("fetches the live meta model list", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "muse-spark-1.1", object: "model", created: 0, owned_by: "meta" },
            { id: "sam-3.1", object: "model", created: 1760000000, owned_by: "meta" },
          ],
        }),
      )) as unknown as typeof fetch
    const models = await fetchMetaModels({ fetchImpl, token: "k" })
    expect(models).toEqual([
      { id: "muse-spark-1.1" },
      { id: "sam-3.1", created: 1760000000 },
    ])
  })

  test("models hook merges new meta models into the catalog", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ data: [{ id: "muse-spark-1.1" }, { id: "sam-3.1", created: 1760000000 }] }),
      )) as unknown as typeof fetch
    const plugin = await MusePlugin({} as never, { fetchImpl })
    const models = await plugin.provider?.models?.(provider, { auth: { type: "api", key: "k" } } as never)
    expect(Object.keys(models ?? {})).toEqual(["muse-spark-1.1", "sam-3.1"])
    const sam = models?.["sam-3.1"]
    expect(sam?.api).toEqual({ id: "sam-3.1", url: "https://api.meta.ai/v1", npm: "@ai-sdk/openai" })
    expect(sam?.release_date).toBe("2025-10-09")
    expect(models?.["muse-spark-1.1"]).toBe(catalogModel)
  })

  test("keeps the catalog on failures and without credentials", async () => {
    const denied = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch
    const plugin = await MusePlugin({} as never, { fetchImpl: denied })
    const models = await plugin.provider?.models?.(provider, { auth: { type: "api", key: "k" } } as never)
    expect(Object.keys(models ?? {})).toEqual(["muse-spark-1.1"])

    const plugin2 = await MusePlugin({} as never, {})
    const models2 = await plugin2.provider?.models?.(provider, {} as never)
    expect(Object.keys(models2 ?? {})).toEqual(["muse-spark-1.1"])
  })
})