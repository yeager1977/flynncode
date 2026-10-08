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
  test("leaves ordinary prose untouched", () => {
    const prose = "Prefer bun over npm for installs in this repo."
    expect(MemoryRedact.redactSecrets(prose)).toBe(prose)
  })
})
