import { describe, expect, test } from "bun:test"
import { providerRows, setProviderEnabled } from "./provider-enabled"

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
