import { describe, expect, it } from "bun:test"
import { containsSecret, redactSecrets } from "../../src/memory/redact"

describe("vendor token redaction", () => {
  it("redacts pasted anthropic keys", () => {
    expect(redactSecrets("key sk-ant-oat123456")).not.toContain("sk-ant-oat123456")
  })
  it("redacts pasted openai keys", () => {
    expect(redactSecrets("key sk-proj-abcdef123456")).not.toContain("sk-proj-abcdef123456")
  })
  it("redacts bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig")).not.toContain("eyJhbGciOiJSUzI1NiJ9")
  })
  it("redacts refresh token assignments", () => {
    const redacted = redactSecrets("refresh_token=supersecretvaluelong")
    expect(redacted).not.toContain("supersecretvaluelong")
    expect(containsSecret("refresh_token=supersecretvaluelong")).toBe(true)
  })
  it("leaves non-secret text untouched", () => {
    expect(redactSecrets("connected (2 models)")).toBe("connected (2 models)")
  })
})
