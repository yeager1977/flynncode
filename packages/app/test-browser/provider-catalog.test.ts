import { expect, test } from "bun:test"
import { QueryClient, useQuery } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createProviderLookup } from "../src/context/global-sync/provider-lookup"
import type { OpencodeClient } from "@flynncode/sdk/v2/client"
import type { CatalogApi } from "@opencode-ai/client/promise"
import { loadProviderCatalogQuery, loadProvidersQuery } from "../src/context/global-sync/bootstrap"
import { selectPopularProviders } from "../src/hooks/provider-catalog"
import { ServerScope } from "../src/utils/server-scope"

function provider(id: string) {
  return {
    id,
    name: id,
    source: "api",
    env: [],
    options: {},
    models: { [`${id}-model`]: { id: `${id}-model`, providerID: id, name: id, status: "active" } },
  }
}

const calls: string[] = []
const legacy = {
  provider: {
    connected: async () => ({
      data: { all: [provider("openai")], connected: ["openai"], default: {} },
      response: new Response(null, { status: 200 }),
    }),
    list: async () => {
      calls.push("list")
      return {
        data: {
          all: [provider("openai"), provider("anthropic"), provider("vercel")],
          connected: ["openai"],
          default: {},
        },
        response: new Response(null, { status: 200 }),
      }
    },
  },
} as unknown as OpencodeClient

// The composer reads the slim connected list; the connect-provider and manage-models dialogs read the
// lazily loaded full catalog, so they must still offer providers that are not connected yet.
test("provider dialogs still list every provider from the lazily loaded catalog", async () => {
  const client = new QueryClient()
  const protocol = Promise.resolve("v1" as const)
  const slim = await client.fetchQuery(loadProvidersQuery(ServerScope.local, null, {} as CatalogApi, legacy, protocol))
  const catalog = await client.fetchQuery(
    loadProviderCatalogQuery(ServerScope.local, {} as CatalogApi, legacy, protocol),
  )

  expect([...slim.all.keys()]).toEqual(["openai"])
  expect([...catalog.all.keys()]).toEqual(["openai", "anthropic", "vercel"])
  expect(selectPopularProviders(catalog.all).map((item) => item.id)).toEqual(["openai", "anthropic", "vercel"])
})

// Old messages can name a provider that is no longer connected. Its name and context limit come from the full
// catalog, which loads on the first lookup that needs it and only once.
test("a provider missing from the connected list resolves from the catalog loaded on demand", async () => {
  calls.length = 0
  const client = new QueryClient()
  const protocol = Promise.resolve("v1" as const)
  const { lookup, dispose } = createRoot((dispose) => ({
    dispose,
    lookup: createProviderLookup((enabled) =>
      useQuery(
        () => ({
          ...loadProviderCatalogQuery(ServerScope.local, {} as CatalogApi, legacy, protocol),
          enabled: enabled(),
        }),
        () => client,
      ),
    ),
  }))
  await Bun.sleep(10)
  expect(calls).toEqual([])

  expect(lookup("anthropic")).toBeUndefined()
  expect(lookup("vercel")).toBeUndefined()
  for (let tries = 0; tries < 100 && !lookup("anthropic"); tries++) await Bun.sleep(10)

  expect(lookup("anthropic")?.models["anthropic-model"]?.name).toBe("anthropic")
  expect(lookup("vercel")?.id).toBe("vercel")
  expect(calls).toEqual(["list"])
  dispose()
})
