import { describe, expect, test } from "bun:test"
import { validateCustomProvider } from "./dialog-custom-provider-form"

const t = (key: string) => key

describe("anthropic template", () => {
  test("saves the native anthropic npm with copied catalog model data", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "anthropic-api",
        name: "Anthropic API",
        baseURL: "https://api.anthropic.com/v1",
        apiKey: " sk-ant-secret ",
        models: [{ row: "m0", id: "claude-opus-5-5", name: "Claude Opus 5.5", err: {} }],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        kind: "anthropic",
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      catalogModels: {
        "claude-opus-5-5": {
          reasoning: true,
          tool_call: true,
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
          limit: { context: 200000, output: 64000 },
        },
      },
    })

    expect(result.result?.config.npm).toBe("@ai-sdk/anthropic")
    expect(result.result?.config.models["claude-opus-5-5"]).toEqual({
      reasoning: true,
      tool_call: true,
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      limit: { context: 200000, output: 64000 },
      name: "Claude Opus 5.5",
    })
  })

  test("does not copy catalog data for entries the user renamed", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "anthropic-api",
        name: "Anthropic API",
        baseURL: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-secret",
        models: [{ row: "m0", id: "my-model", name: "My model", err: {} }],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        kind: "anthropic",
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      catalogModels: { "claude-opus-5-5": { reasoning: true } },
    })

    expect(result.result?.config.models["my-model"]).toEqual({ name: "My model" })
  })
})

describe("validateCustomProvider", () => {
  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", err: {} }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("flags duplicate rows and allows reconnecting disabled providers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: ["custom-provider"],
      existingProviderIDs: new Set(["custom-provider"]),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })
})
