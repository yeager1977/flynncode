import { describe, expect, test } from "bun:test"
import { providerRows, removeProviderPatch, setProviderEnabled } from "./provider-enabled"

describe("setProviderEnabled", () => {
  test("adds one id and keeps the rest", () => {
    expect(setProviderEnabled(["ollama-local"], "xai", false)).toEqual(["ollama-local", "xai"])
  })

  test("removes one id and keeps the rest", () => {
    expect(setProviderEnabled(["ollama-local", "xai"], "xai", true)).toEqual(["ollama-local"])
  })

  test("does not duplicate an existing ban", () => {
    expect(setProviderEnabled(["xai"], "xai", false)).toEqual(["xai"])
  })
})

describe("providerRows", () => {
  test("keeps a disabled id that the catalog omitted", () => {
    expect(
      providerRows({
        connected: [{ id: "ollama-cloud", name: "Ollama Cloud" }],
        disabled: ["xai", "ollama-local"],
        configuredNames: { xai: "xAI" },
      }),
    ).toEqual([
      { id: "ollama-cloud", name: "Ollama Cloud", enabled: true },
      { id: "xai", name: "xAI", enabled: false },
      { id: "ollama-local", name: "ollama-local", enabled: false },
    ])
  })
})

describe("removeProviderPatch", () => {
  test("empties the provider entry and drops only its ban", () => {
    expect(removeProviderPatch(["ollama-local", "meta", "xai"], "meta")).toEqual({
      provider: { meta: {} },
      disabled_providers: ["ollama-local", "xai"],
    })
  })

  test("still empties the entry when the provider was not banned", () => {
    expect(removeProviderPatch(["xai"], "meta")).toEqual({ provider: { meta: {} }, disabled_providers: ["xai"] })
  })
})
