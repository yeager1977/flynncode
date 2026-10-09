import { describe, expect, test } from "bun:test"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { MachineSyncConfig } from "@/machine-sync/config-sync"

const localText = `{
  // providers on this machine
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-old",
  "server": { "port": 4096 },
  "provider": {
    "anthropic": { "options": { "apiKey": "sk-local", "baseURL": "https://api.anthropic.com" } }
  },
  "mcp": {
    "github": { "type": "remote", "url": "https://mcp.example", "headers": { "Authorization": "Bearer local" } }
  }
}
`

describe("MachineSyncConfig.sanitizeConfig", () => {
  test("never sends secrets, references, auth headers, or the server block", () => {
    const sent = MachineSyncConfig.sanitizeConfig({
      model: "anthropic/claude",
      server: { port: 4096, password: "pw-server" },
      provider: {
        anthropic: { options: { apiKey: "sk-ant", baseURL: "{env:BASE_URL}", headers: { "X-Org": "org-1" } } },
      },
      mcp: {
        github: {
          type: "remote",
          url: "https://mcp.example",
          headers: { Authorization: "Bearer gh" },
          environment: { GITHUB_TOKEN: "ghp-1" },
        },
      },
      plugin_secret: "plain-secret",
      instructions: ["{file:~/notes.md}", "AGENTS.md"],
    })
    const text = JSON.stringify(sent)
    for (const secret of [
      "sk-ant",
      "{env:BASE_URL}",
      "org-1",
      "Bearer gh",
      "ghp-1",
      "plain-secret",
      "{file:~/notes.md}",
      "pw-server",
    ])
      expect(text).not.toContain(secret)
    expect(sent.server).toBeUndefined()
    expect(sent.model).toBe("anthropic/claude")
    expect(sent.plugin_secret).toBe(MachineSyncConfig.SECRET_PLACEHOLDER)
    expect(sent.instructions).toEqual([MachineSyncConfig.SECRET_PLACEHOLDER, "AGENTS.md"])
  })

  test("masks suffix-matched secret keys but not look-alikes such as maxTokens", () => {
    const sent = MachineSyncConfig.sanitizeConfig({
      limit: { maxTokens: 4096 },
      oauth: { accessToken: "at-1", refresh_token: "rt-1", clientSecret: "cs-1", API_KEY: "k-1", password: "pw" },
      plugin: { options: { nested: { deeper: { token: "deep-token" } } } },
    })
    expect(sent.limit).toEqual({ maxTokens: 4096 })
    const text = JSON.stringify(sent)
    for (const secret of ["at-1", "rt-1", "cs-1", "k-1", "pw", "deep-token"]) expect(text).not.toContain(secret)
  })

  test("masks secrets inside arrays and references embedded in longer strings", () => {
    const sent = MachineSyncConfig.sanitizeConfig({
      mcp: { local: { type: "local", command: ["run", "--key={env:SECRET_KEY}"] } },
      list: [{ token: "in-array" }],
    })
    const text = JSON.stringify(sent)
    expect(text).not.toContain("SECRET_KEY")
    expect(text).not.toContain("in-array")
  })

  test("does not mutate its input and tolerates non-objects", () => {
    const input = { provider: { a: { options: { apiKey: "sk" } } } }
    MachineSyncConfig.sanitizeConfig(input)
    expect(input.provider.a.options.apiKey).toBe("sk")
    expect(MachineSyncConfig.sanitizeConfig(null)).toEqual({})
    expect(MachineSyncConfig.sanitizeConfig("x")).toEqual({})
  })
})

describe("MachineSyncConfig.isSecretPath", () => {
  test("flags credential keys and header values only", () => {
    expect(MachineSyncConfig.isSecretPath(["provider", "a", "options", "apiKey"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["provider", "a", "options", "headers", "X-Any"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["mcp", "gh", "headers", "Authorization"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["limit", "maxTokens"])).toBe(false)
    expect(MachineSyncConfig.isSecretPath(["model"])).toBe(false)
    expect(MachineSyncConfig.isSecretPath(["agent", "headers", "x"])).toBe(false)
    expect(MachineSyncConfig.isSecretPath([])).toBe(false)
  })
})

describe("MachineSyncConfig.applyPeerConfig", () => {
  const peer = MachineSyncConfig.sanitizeConfig({
    $schema: "https://opencode.ai/config.json",
    model: "anthropic/claude-new",
    server: { port: 9999 },
    provider: {
      anthropic: { options: { apiKey: "sk-peer", baseURL: "https://api.anthropic.com" } },
      openai: { options: { apiKey: "sk-openai" } },
    },
    mcp: { github: { type: "remote", url: "https://mcp.example", headers: { Authorization: "Bearer peer" } } },
  })
  const next = MachineSyncConfig.applyPeerConfig({
    localText,
    local: ConfigParse.jsonc(localText, "opencode.jsonc"),
    peer,
  })

  test("takes the peer's values and keeps comments", () => {
    expect(next).toContain("anthropic/claude-new")
    expect(next).toContain("// providers on this machine")
  })

  test("keeps local secrets and the local server block", () => {
    expect(next).toContain("sk-local")
    expect(next).toContain("Bearer local")
    expect(next).toContain("4096")
    expect(next).not.toContain("9999")
  })

  test("never writes placeholders and leaves peer-only secrets absent", () => {
    expect(next).not.toContain(MachineSyncConfig.SECRET_PLACEHOLDER)
    expect(next).not.toContain("sk-peer")
    expect(next).not.toContain("sk-openai")
    expect(ConfigParse.jsonc(next, "opencode.jsonc")).toMatchObject({ provider: { openai: { options: {} } } })
  })

  test("removes keys the peer dropped but never drops a local secret", () => {
    const trimmed = MachineSyncConfig.applyPeerConfig({
      localText,
      local: ConfigParse.jsonc(localText, "opencode.jsonc"),
      peer: { model: "anthropic/claude-new" },
    })
    expect(trimmed).not.toContain("https://mcp.example")
    expect(trimmed).not.toContain("baseURL")
    expect(trimmed).toContain("sk-local")
    expect(trimmed).toContain("Bearer local")
  })

  test("never writes a placeholder even when the peer sends it where nothing local exists", () => {
    const result = MachineSyncConfig.applyPeerConfig({
      localText: "",
      local: undefined,
      peer: {
        model: "m",
        token: MachineSyncConfig.SECRET_PLACEHOLDER,
        instructions: [MachineSyncConfig.SECRET_PLACEHOLDER, "AGENTS.md"],
        nested: { list: [{ x: MachineSyncConfig.SECRET_PLACEHOLDER }], apiKey: MachineSyncConfig.SECRET_PLACEHOLDER },
      },
    })
    expect(result).not.toContain(MachineSyncConfig.SECRET_PLACEHOLDER)
    expect(ConfigParse.jsonc(result, "opencode.jsonc")).toMatchObject({ model: "m" })
  })

  test("keeps a local secret when the peer value differs or is a real-looking secret", () => {
    // A hostile or buggy peer that sends a plain secret value must not overwrite the local one.
    const result = MachineSyncConfig.applyPeerConfig({
      localText,
      local: ConfigParse.jsonc(localText, "opencode.jsonc"),
      peer: {
        provider: { anthropic: { options: { apiKey: "sk-attacker" } } },
        mcp: { github: { type: "remote", url: "https://mcp.example", headers: { Authorization: "Bearer attacker" } } },
        server: { port: 1 },
      },
    })
    expect(result).toContain("sk-local")
    expect(result).toContain("Bearer local")
    expect(result).not.toContain("sk-attacker")
    expect(result).not.toContain("Bearer attacker")
    expect(ConfigParse.jsonc(result, "opencode.jsonc")).toMatchObject({ server: { port: 4096 } })
  })

  test("preserves local reference strings (env/file) the peer could not see", () => {
    const text = `{ "provider": { "a": { "options": { "baseURL": "{env:BASE}" } } }, "model": "old" }`
    const result = MachineSyncConfig.applyPeerConfig({
      localText: text,
      local: ConfigParse.jsonc(text, "opencode.jsonc"),
      peer: MachineSyncConfig.sanitizeConfig({ provider: { a: { options: { baseURL: "{env:BASE}" } } }, model: "new" }),
    })
    expect(result).toContain("{env:BASE}")
    expect(result).toContain("new")
    expect(result).not.toContain(MachineSyncConfig.SECRET_PLACEHOLDER)
  })

  test("applying the same sanitized config twice is idempotent", () => {
    const local = ConfigParse.jsonc(localText, "opencode.jsonc")
    const once = MachineSyncConfig.applyPeerConfig({ localText, local, peer })
    const twice = MachineSyncConfig.applyPeerConfig({
      localText: once,
      local: ConfigParse.jsonc(once, "opencode.jsonc"),
      peer,
    })
    expect(twice).toBe(once)
  })
})

describe("Config.validateText", () => {
  test("accepts a valid config and rejects an invalid one", () => {
    expect(() => Config.validateText(`{ "model": "anthropic/claude" }`, "opencode.jsonc")).not.toThrow()
    expect(() => Config.validateText(`{ "model": 42 }`, "opencode.jsonc")).toThrow()
  })
})
