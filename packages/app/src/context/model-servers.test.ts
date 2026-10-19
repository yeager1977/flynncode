import { describe, expect, test } from "bun:test"
import { modelServers } from "./model-servers"

describe("modelServers", () => {
  const item = (providerID: string, providerName: string, modelID = "glm-5.3-flash") => ({
    id: modelID,
    provider: { id: providerID, name: providerName },
  })

  test("returns one option per provider offering the model", () => {
    const options = modelServers({
      items: [item("ollama-gpu", "Ollama"), item("ollama-cloud", "Ollama"), item("anthropic", "Anthropic", "claude")],
      modelID: "glm-5.3-flash",
    })
    expect(options.map((option) => option.providerID)).toEqual(["ollama-cloud", "ollama-gpu"])
    expect(options.every((option) => option.id === "glm-5.3-flash")).toBe(true)
  })

  test("puts the current provider first and flags it", () => {
    const options = modelServers({
      items: [item("ollama-gpu", "Ollama"), item("ollama-cloud", "Ollama")],
      modelID: "glm-5.3-flash",
      current: "ollama-gpu",
    })
    expect(options[0]).toEqual({ id: "glm-5.3-flash", label: "Ollama (ollama-gpu)", providerID: "ollama-gpu", current: true })
  })

  test("disambiguates identical provider names with the provider id", () => {
    const options = modelServers({
      items: [item("ollama-gpu", "Ollama"), item("ollama-cloud", "Ollama")],
      modelID: "glm-5.3-flash",
    })
    expect(options.map((option) => option.label)).toEqual([
      "Ollama (ollama-cloud)",
      "Ollama (ollama-gpu)",
    ])
  })

  test("keeps the plain provider name when it is unique", () => {
    const options = modelServers({
      items: [item("ollama-gpu", "Ollama GPU"), item("anthropic", "Anthropic", "claude")],
      modelID: "glm-5.3-flash",
    })
    expect(options.map((option) => option.label)).toEqual(["Ollama GPU"])
  })

  test("is empty when no provider hosts the model", () => {
    expect(modelServers({ items: [item("anthropic", "Anthropic", "claude")], modelID: "glm-5.3-flash" })).toEqual([])
  })
})
