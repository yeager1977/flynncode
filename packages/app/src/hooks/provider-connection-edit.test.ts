import { describe, expect, test } from "bun:test"
import {
  canEditProvider,
  isConfigCustomProvider,
  providerAuthKind,
  providerEditPrefill,
  validateProviderEdit,
} from "./provider-connection-edit"

const t = (key: string) => key

const customEntry = {
  npm: "@ai-sdk/openai-compatible",
  name: "Example",
  options: {
    baseURL: "https://api.example.com/v1",
    apiKey: "config-secret",
    headers: { "X-Test": "enabled" },
  },
  models: { "model-a": { name: "Model A" } },
}

describe("providerAuthKind", () => {
  test("maps provider sources to edit auth kinds", () => {
    expect(providerAuthKind("env")).toBe("env")
    expect(providerAuthKind("custom")).toBe("oauth")
    expect(providerAuthKind("api")).toBe("api")
    expect(providerAuthKind("config")).toBe("api")
    expect(providerAuthKind(undefined)).toBe("api")
  })
})

describe("canEditProvider", () => {
  test("allows editing only under the v1 protocol", () => {
    expect(canEditProvider("v1")).toBe(true)
    expect(canEditProvider("v2")).toBe(false)
  })
})

describe("isConfigCustomProvider", () => {
  test("requires the openai-compatible package and a non-empty model list", () => {
    expect(isConfigCustomProvider(customEntry)).toBe(true)
    expect(isConfigCustomProvider({ ...customEntry, models: {} })).toBe(false)
    expect(isConfigCustomProvider({ ...customEntry, npm: "@ai-sdk/anthropic" })).toBe(false)
    expect(isConfigCustomProvider(undefined)).toBe(false)
  })
})

describe("providerEditPrefill", () => {
  test("extracts base URL, headers, and models for a custom provider", () => {
    const result = providerEditPrefill({ provider: customEntry, configCustom: true })

    expect(result.baseURL).toBe("https://api.example.com/v1")
    expect(result.headers.map((h) => [h.key, h.value])).toEqual([["X-Test", "enabled"]])
    expect(result.models.map((m) => [m.id, m.name])).toEqual([["model-a", "Model A"]])
  })

  test("omits models for a built-in provider", () => {
    const result = providerEditPrefill({ provider: customEntry, configCustom: false })

    expect(result.models).toEqual([])
  })

  test("returns empty values for a provider with no config entry", () => {
    const result = providerEditPrefill({ provider: undefined, configCustom: false })

    expect(result.baseURL).toBe("")
    expect(result.headers).toEqual([])
    expect(result.models).toEqual([])
  })
})

describe("validateProviderEdit", () => {
  test("allows an empty base URL for a built-in provider and preserves existing options", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [],
      },
      t,
      configCustom: false,
      existing: customEntry,
    })

    expect(result.err.baseURL).toBeUndefined()
    expect(result.result?.key).toBeUndefined()
    expect(result.result?.provider).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Example",
      options: { apiKey: "config-secret" },
      models: { "model-a": { name: "Model A" } },
    })
  })

  test("requires a base URL for a custom provider", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "  ",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [{ row: "m0", id: "model-a", name: "Model A", err: {} }],
      },
      t,
      configCustom: true,
      existing: customEntry,
    })

    expect(result.result).toBeUndefined()
    expect(result.err.baseURL).toBe("provider.custom.error.baseURL.required")
  })

  test("flags a malformed base URL", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "api.example.com",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [],
      },
      t,
      configCustom: false,
      existing: undefined,
    })

    expect(result.result).toBeUndefined()
    expect(result.err.baseURL).toBe("provider.custom.error.baseURL.format")
  })

  test("flags duplicate headers and duplicate models", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "https://api.example.com/v1",
        apiKey: "",
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
      },
      t,
      configCustom: true,
      existing: customEntry,
    })

    expect(result.result).toBeUndefined()
    expect(result.headers[1]).toEqual({ key: "provider.custom.error.duplicate", value: undefined })
    expect(result.models[1]).toEqual({ id: "provider.custom.error.duplicate", name: undefined })
  })

  test("moves an entered key to the auth store and drops the config apiKey", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "https://api.example.com/v1",
        apiKey: "new-secret",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [{ row: "m0", id: "model-a", name: "Model A", err: {} }],
      },
      t,
      configCustom: true,
      existing: customEntry,
    })

    expect(result.result?.key).toBe("new-secret")
    expect(result.result?.provider).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Example",
      options: { baseURL: "https://api.example.com/v1" },
      models: { "model-a": { name: "Model A" } },
    })
  })

  test("removes headers when the header rows are cleared", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "https://api.example.com/v1",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [{ row: "m0", id: "model-a", name: "Model A", err: {} }],
      },
      t,
      configCustom: true,
      existing: customEntry,
    })

    expect(result.result?.provider?.options).toEqual({
      apiKey: "config-secret",
      baseURL: "https://api.example.com/v1",
    })
  })

  test("omits the provider entry for a built-in provider with no config and only a key", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "",
        apiKey: "new-secret",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [],
      },
      t,
      configCustom: false,
      existing: undefined,
    })

    expect(result.result).toEqual({ key: "new-secret" })
  })

  test("omits both the provider entry and key when nothing changed", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [],
      },
      t,
      configCustom: false,
      existing: undefined,
    })

    expect(result.result).toEqual({ key: undefined })
  })
})