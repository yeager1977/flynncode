import { describe, expect, it } from "bun:test"
import { parseClaudeCredentials, parseCodexAuth, readEnvCredential } from "../../src/auth/vendor-import"

describe("parseClaudeCredentials", () => {
  it("accepts Claude Code OAuth shape", () => {
    const result = parseClaudeCredentials({
      claudeAiOauth: { accessToken: "sk-ant-oat1", refreshToken: "sk-ant-ort1", expiresAt: Date.now() + 3600_000 },
    })
    expect(result?.kind).toBe("oauth")
    expect(result?.vendor).toBe("anthropic")
  })
  it("tolerates real-world extra keys", () => {
    const result = parseClaudeCredentials({
      claudeAiOauth: {
        accessToken: "sk-ant-oat1",
        refreshToken: "sk-ant-ort1",
        expiresAt: Date.now() + 3600_000,
        scopes: ["user:profile"],
        subscriptionType: "max",
        rateLimitTier: "default",
      },
    })
    expect(result?.kind).toBe("oauth")
  })
  it("rejects garbage without leaking values", () => {
    expect(parseClaudeCredentials({ claudeAiOauth: { accessToken: 42 } })).toBeUndefined()
  })
  it("rejects empty tokens", () => {
    const result = parseClaudeCredentials({
      claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 },
    })
    expect(result).toBeUndefined()
  })
})

describe("parseCodexAuth", () => {
  it("accepts Codex CLI tokens shape", () => {
    const result = parseCodexAuth({
      tokens: { access_token: "a1", refresh_token: "r1", id_token: "h.e.s" },
    })
    expect(result?.vendor).toBe("openai")
    expect(result?.kind).toBe("oauth")
  })
  it("carries account_id through as accountId", () => {
    const result = parseCodexAuth({
      tokens: { access_token: "a1", refresh_token: "r1", account_id: "acc-1" },
    })
    expect(result).toMatchObject({ vendor: "openai", kind: "oauth", accountId: "acc-1" })
  })
  it("rejects garbage", () => {
    expect(parseCodexAuth({ tokens: { access_token: 7 } })).toBeUndefined()
    expect(parseCodexAuth({})).toBeUndefined()
  })
})

describe("readEnvCredential", () => {
  it("reads ANTHROPIC_API_KEY", () => {
    expect(readEnvCredential("anthropic", { ANTHROPIC_API_KEY: "sk-ant-x" })?.kind).toBe("api")
  })
  it("reads OPENAI_API_KEY", () => {
    expect(readEnvCredential("openai", { OPENAI_API_KEY: "sk-x" })).toMatchObject({ vendor: "openai", kind: "api" })
  })
  it("returns undefined when missing or empty", () => {
    expect(readEnvCredential("anthropic", {})).toBeUndefined()
    expect(readEnvCredential("openai", { OPENAI_API_KEY: "" })).toBeUndefined()
  })
})
