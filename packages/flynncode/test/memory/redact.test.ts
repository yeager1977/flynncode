import { describe, expect, test } from "bun:test"
import { MemoryRedact } from "../../src/memory/redact"

describe("redactSecrets", () => {
  test("redacts github and openai style tokens", () => {
    const out = MemoryRedact.redactSecrets("key ghp_abcdefghij1234567890 done sk-sk_test_abcdefghij123456")
    expect(out).not.toContain("ghp_abcdefghij1234567890")
    expect(out).toContain("[redacted:github]")
    expect(out).toContain("[redacted:openai]")
  })
  test("redacts private key blocks and aws keys", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIBvTCCAT\n-----END PRIVATE KEY-----"
    expect(MemoryRedact.redactSecrets(key)).toContain("[redacted:private-key]")
    expect(MemoryRedact.redactSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[redacted:aws-key]")
  })
  test("redacts bearer/basic auth headers and url credentials", () => {
    expect(MemoryRedact.redactSecrets("Authorization: Bearer abcdefghij123456")).toContain("[redacted:bearer]")
    expect(MemoryRedact.redactSecrets("https://user:s3cr3tpass@example.com/x")).not.toContain("s3cr3tpass")
  })
  test("redacts generic assignments like api_key and .env lines", () => {
    const out = MemoryRedact.redactSecrets('OPENAI_API_KEY="sk-live-1234567890abcdef"')
    expect(out).not.toContain("sk-live-1234567890abcdef")
    expect(out).toContain("[redacted:generic-secret]")
  })
  test("redacts jwt, anthropic, gcp and stripe patterns", () => {
    const input = "jwt eyJhbGciOiJIUzI1NiJ9.e30.KKkK; anthropic sk-ant-api03-x; gcp AIzaSyA1; stripe sk_live_51abc"
    const out = MemoryRedact.redactSecrets(input)
    expect(out).not.toContain("eyJ")
    expect(out).not.toContain("sk-ant")
    expect(out).not.toContain("AIzaSy")
    expect(out).not.toContain("sk_live_")
    expect(out).toContain("[redacted:jwt]")
    expect(out).toContain("[redacted:anthropic]")
    expect(out).toContain("[redacted:gcp]")
    expect(out).toContain("[redacted:stripe]")
  })
  test("redacts stripe restricted keys and existing patterns stay byte-identical", () => {
    expect(MemoryRedact.redactSecrets("key rk_live_abcdefghijklmnopqrst")).toContain("[redacted:stripe]")
    expect(MemoryRedact.redactSecrets("key ghp_abcdefghij1234567890")).toContain("[redacted:github]")
  })
  test("leaves ordinary prose untouched", () => {
    const prose = "Prefer bun over npm for installs in this repo."
    expect(MemoryRedact.redactSecrets(prose)).toBe(prose)
  })
})
