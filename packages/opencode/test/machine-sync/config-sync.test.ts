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

  test("masks every value under any headers, env or environment map", () => {
    const sent = MachineSyncConfig.sanitizeConfig({
      agent: { build: { headers: { "X-Org": "org-secret" } } },
      shell: { env: { FOO_KEY: "foo-secret", PLAIN: "plain-secret" } },
      mcp: { local: { type: "local", command: ["x"], environment: { ANY: "env-secret" } } },
    })
    const text = JSON.stringify(sent)
    for (const secret of ["org-secret", "foo-secret", "plain-secret", "env-secret"]) expect(text).not.toContain(secret)
    expect(text).toContain('"X-Org"')
  })

  test("masks cloud provider credentials: Bedrock keys, Vertex service accounts, bare keys, authorization", () => {
    const sent = MachineSyncConfig.sanitizeConfig({
      provider: {
        "amazon-bedrock": {
          options: {
            region: "us-east-1",
            accessKeyId: "AKIA-1",
            secretAccessKey: "bedrock-secret",
            sessionToken: "st",
          },
        },
        "google-vertex": {
          options: {
            project: "my-project",
            googleAuthOptions: { credentials: { client_email: "svc@x.iam", private_key: "-----BEGIN PK-----" } },
          },
        },
        vertex: { options: { credentials: { private_key: "pk-2", client_id: "cid" } } },
        azure: { options: { key: "azure-key", authorization: "Bearer az", resourceName: "res" } },
      },
      limit: { maxTokens: 4096, max_tokens: 2048 },
    })
    const text = JSON.stringify(sent)
    for (const secret of [
      "AKIA-1",
      "bedrock-secret",
      "-----BEGIN PK-----",
      "svc@x.iam",
      "pk-2",
      "cid",
      "azure-key",
      "Bearer az",
    ])
      expect(text).not.toContain(secret)
    for (const plain of ["us-east-1", "my-project", "res"]) expect(text).toContain(plain)
    expect(sent.limit).toEqual({ maxTokens: 4096, max_tokens: 2048 })
  })

  test("syncs credential switches such as includeCredentials, but masks credential values", () => {
    const sent = MachineSyncConfig.sanitizeConfig({
      provider: { a: { options: { includeCredentials: true, credentials: "secret-cred", fetchCredentials: false } } },
    })
    expect(sent.provider).toEqual({
      a: {
        options: {
          includeCredentials: true,
          credentials: MachineSyncConfig.SECRET_PLACEHOLDER,
          fetchCredentials: false,
        },
      },
    })
    const text = `{ "provider": { "a": { "options": { "includeCredentials": false } } } }`
    const merged = MachineSyncConfig.applyPeerConfig({
      localText: text,
      local: ConfigParse.jsonc(text, "opencode.jsonc"),
      peer: { provider: { a: { options: { includeCredentials: true } } } },
    })
    expect(ConfigParse.jsonc(merged, "opencode.jsonc")).toEqual({
      provider: { a: { options: { includeCredentials: true } } },
    })
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
    expect(MachineSyncConfig.isSecretPath(["agent", "a", "headers", "x"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["shell", "env", "FOO_KEY"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["mcp", "gh", "environment", "ANYTHING"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["mcp", "gh", "environment"])).toBe(false)
    expect(MachineSyncConfig.isSecretPath([])).toBe(false)
    expect(MachineSyncConfig.isSecretPath(["provider", "b", "options", "secretAccessKey"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["provider", "b", "options", "accessKeyId"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["provider", "v", "options", "credentials", "private_key"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["provider", "v", "options", "googleAuthOptions", "scopes"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["provider", "a", "options", "key"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["provider", "a", "options", "authorization"])).toBe(true)
    expect(MachineSyncConfig.isSecretPath(["keybinds", "leader"])).toBe(false)
    expect(MachineSyncConfig.isSecretPath(["provider", "a", "models", "m", "limit", "max_tokens"])).toBe(false)
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

  test("keeps local cloud credentials when the peer edits the rest of the provider", () => {
    const text = `{ "provider": { "amazon-bedrock": { "options": { "region": "us-east-1", "accessKeyId": "AKIA-local", "secretAccessKey": "local-secret" } }, "vertex": { "options": { "project": "p1", "googleAuthOptions": { "credentials": { "private_key": "local-pk" } } } } } }`
    const sent = MachineSyncConfig.sanitizeConfig({
      provider: {
        "amazon-bedrock": {
          options: { region: "eu-west-1", accessKeyId: "AKIA-peer", secretAccessKey: "peer-secret" },
        },
        vertex: { options: { project: "p2", googleAuthOptions: { credentials: { private_key: "peer-pk" } } } },
      },
    })
    const merged = MachineSyncConfig.applyPeerConfig({
      localText: text,
      local: ConfigParse.jsonc(text, "opencode.jsonc"),
      peer: sent,
    })
    expect(ConfigParse.jsonc(merged, "opencode.jsonc")).toEqual({
      provider: {
        "amazon-bedrock": {
          options: { region: "eu-west-1", accessKeyId: "AKIA-local", secretAccessKey: "local-secret" },
        },
        vertex: { options: { project: "p2", googleAuthOptions: { credentials: { private_key: "local-pk" } } } },
      },
    })
  })

  test("removes keys the peer dropped, but keeps a dropped subtree whole when it holds a local secret", () => {
    const text = `{ "share": "manual", "model": "old", "mcp": { "gh": { "type": "remote", "url": "https://mcp.example", "headers": { "Authorization": "Bearer local" } } } }`
    const trimmed = MachineSyncConfig.applyPeerConfig({
      localText: text,
      local: ConfigParse.jsonc(text, "opencode.jsonc"),
      peer: { model: "new" },
    })
    const parsed = ConfigParse.jsonc(trimmed, "opencode.jsonc")
    expect(parsed).toEqual({
      model: "new",
      mcp: { gh: { type: "remote", url: "https://mcp.example", headers: { Authorization: "Bearer local" } } },
    })
    expect(() => Config.validateText(trimmed, "opencode.jsonc")).not.toThrow()
  })

  test("keeps local secrets and the rest of a provider the peer dropped", () => {
    const trimmed = MachineSyncConfig.applyPeerConfig({
      localText,
      local: ConfigParse.jsonc(localText, "opencode.jsonc"),
      peer: { model: "anthropic/claude-new" },
    })
    expect(trimmed).toContain("sk-local")
    expect(trimmed).toContain("Bearer local")
    expect(() => Config.validateText(trimmed, "opencode.jsonc")).not.toThrow()
  })

  describe("a peer value of a different shape never replaces a local secret subtree", () => {
    const apply = (text: string, peer: Record<string, unknown>) =>
      ConfigParse.jsonc(
        MachineSyncConfig.applyPeerConfig({ localText: text, local: ConfigParse.jsonc(text, "opencode.jsonc"), peer }),
        "opencode.jsonc",
      )

    test("lsp: false over a server with env", () => {
      const text = `{ "lsp": { "ts": { "command": ["x"], "env": { "FOO_KEY": "lsp-secret" } } } }`
      expect(apply(text, { lsp: false })).toEqual(ConfigParse.jsonc(text, "opencode.jsonc"))
    })

    test("formatter: false over a formatter with environment", () => {
      const text = `{ "formatter": { "prettier": { "command": ["p"], "environment": { "TOKEN_X": "fmt-secret" } } } }`
      expect(apply(text, { formatter: false })).toEqual(ConfigParse.jsonc(text, "opencode.jsonc"))
    })

    test("mcp oauth: false over a clientSecret", () => {
      const text = `{ "mcp": { "gh": { "type": "remote", "url": "https://x", "oauth": { "clientId": "id", "clientSecret": "cs-local" } } } }`
      const result = apply(text, { mcp: { gh: { type: "remote", url: "https://x", oauth: false } } })
      expect(result).toEqual(ConfigParse.jsonc(text, "opencode.jsonc"))
    })

    test("a record over a local array with a secret, and an array over a local record with a secret", () => {
      const arrayText = `{ "plugin": [["x", { "apiKey": "arr-secret" }]] }`
      expect(apply(arrayText, { plugin: { a: 1 } })).toEqual(ConfigParse.jsonc(arrayText, "opencode.jsonc"))
      const recordText = `{ "x": { "token": "rec-secret" } }`
      expect(apply(recordText, { x: ["a"] })).toEqual(ConfigParse.jsonc(recordText, "opencode.jsonc"))
    })

    test("a subtree without secrets is still replaced by a primitive", () => {
      const text = `{ "lsp": { "ts": { "command": ["x"] } } }`
      expect(apply(text, { lsp: false })).toEqual({ lsp: false })
    })
  })

  test("keeps local env values under any env map", () => {
    const text = `{ "shell": { "env": { "FOO_KEY": "keep-me" } }, "model": "old" }`
    const result = MachineSyncConfig.applyPeerConfig({
      localText: text,
      local: ConfigParse.jsonc(text, "opencode.jsonc"),
      peer: MachineSyncConfig.sanitizeConfig({ shell: { env: { FOO_KEY: "peer-value", OTHER: "x" } }, model: "new" }),
    })
    expect(result).toContain("keep-me")
    expect(result).not.toContain("peer-value")
    expect(result).not.toContain(MachineSyncConfig.SECRET_PLACEHOLDER)
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
