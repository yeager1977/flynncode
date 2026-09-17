import { expect, test } from "bun:test"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import {
  canReplaceProviderApiKey,
  completeProviderConnection,
  resolveDefaultModel,
  selectProviderCatalog,
} from "./provider-catalog"

const catalog = (id: string): NormalizedProviderListResponse => ({
  all: new Map([[id, { id, name: id, source: "api", env: [], options: {}, models: {} }]]),
  connected: [id],
  default: { [id]: `${id}-model` },
})

test("selects the ready catalog for an explicit directory", () => {
  const directory = catalog("directory")

  expect(
    selectProviderCatalog({
      explicit: true,
      directory: "/repo",
      catalog: { ready: true, providers: directory },
    }),
  ).toBe(directory)
})

test("returns an empty catalog while an explicit directory is unresolved", () => {
  expect(selectProviderCatalog({ explicit: true })).toEqual({ all: new Map(), connected: [], default: {} })
  expect(
    selectProviderCatalog({
      explicit: true,
      directory: "/repo",
      catalog: { ready: false, providers: catalog("directory") },
    }),
  ).toEqual({ all: new Map(), connected: [], default: {} })
})

test("uses the route catalog when it is ready", () => {
  const directory = catalog("directory")

  expect(
    selectProviderCatalog({
      explicit: false,
      directory: "/repo",
      catalog: { ready: true, providers: directory },
      global: catalog("global"),
    }),
  ).toBe(directory)
})

test("falls back to the global catalog for route consumers", () => {
  const global = catalog("global")

  expect(selectProviderCatalog({ explicit: false, global })).toBe(global)
  expect(
    selectProviderCatalog({
      explicit: false,
      directory: "/repo",
      catalog: { ready: false, providers: catalog("directory") },
      global,
    }),
  ).toBe(global)
})

test("uses the current server default model", () => {
  expect(resolveDefaultModel({ providerID: "openai", modelID: "gpt-5" }, "anthropic/claude")).toEqual({
    providerID: "openai",
    modelID: "gpt-5",
  })
})

test("does not use legacy config when the current server has no default", () => {
  expect(resolveDefaultModel(null, "anthropic/claude")).toBeUndefined()
})

test("uses config for legacy servers", () => {
  expect(resolveDefaultModel(undefined, "anthropic/claude")).toEqual({
    providerID: "anthropic",
    modelID: "claude",
  })
})

test("only Ollama Cloud exposes API key replacement", () => {
  expect(canReplaceProviderApiKey("ollama-cloud")).toBe(true)
  expect(canReplaceProviderApiKey("ollama-local")).toBe(false)
  expect(canReplaceProviderApiKey("openai")).toBe(false)
})

test("reenables a disabled provider before refreshing the catalog", async () => {
  const events: Array<{ type: "update"; disabled: string[] } | { type: "refresh" }> = []
  const result = await completeProviderConnection({
    providerID: "ollama-cloud",
    disabledProviders: ["ollama-local", "ollama-cloud"],
    updateConfig: async (config) => {
      events.push({ type: "update", disabled: config.disabled_providers })
    },
    refreshProviders: async () => {
      events.push({ type: "refresh" })
    },
  })

  expect(result).toEqual({ ok: true })
  expect(events).toEqual([{ type: "update", disabled: ["ollama-local"] }, { type: "refresh" }])
})

test("reports a provider reenable failure without refreshing", async () => {
  const failure = new Error("config update failed")
  let refreshed = false

  const result = await completeProviderConnection({
    providerID: "ollama-cloud",
    disabledProviders: ["ollama-cloud"],
    updateConfig: async () => {
      throw failure
    },
    refreshProviders: async () => {
      refreshed = true
    },
  })

  expect(result).toEqual({ ok: false, error: failure })
  expect(refreshed).toBe(false)
})

test("reports a provider refresh failure", async () => {
  const failure = new Error("provider refresh failed")

  const result = await completeProviderConnection({
    providerID: "ollama-cloud",
    refreshProviders: async () => {
      throw failure
    },
    updateConfig: async () => {},
  })

  expect(result).toEqual({ ok: false, error: failure })
})
