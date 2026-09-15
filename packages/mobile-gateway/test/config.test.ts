import { describe, expect, test } from "bun:test"
import { envAuthHeader, resolveOptions } from "../src/config"

const base = {
  OPENCODE_SERVER_PASSWORD: "secret",
}

describe("resolveOptions", () => {
  test("applies defaults", () => {
    const result = resolveOptions(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.host).toBe("0.0.0.0")
    expect(result.value.port).toBe(4097)
    expect(result.value.upstream).toBe("http://127.0.0.1:4096")
    expect(result.value.username).toBe("opencode")
    expect(result.value.password).toBe("secret")
  })

  test("reads overrides", () => {
    const result = resolveOptions({
      ...base,
      OPENCODE_MOBILE_HOST: "127.0.0.1",
      OPENCODE_MOBILE_PORT: "5100",
      OPENCODE_MOBILE_UPSTREAM: "http://127.0.0.1:8080/",
      OPENCODE_SERVER_USERNAME: "someone",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.host).toBe("127.0.0.1")
    expect(result.value.port).toBe(5100)
    expect(result.value.upstream).toBe("http://127.0.0.1:8080")
    expect(result.value.username).toBe("someone")
  })

  test("accepts port 0 as ephemeral", () => {
    const result = resolveOptions({ ...base, OPENCODE_MOBILE_PORT: "0" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.port).toBe(0)
  })

  test("rejects a missing or empty password", () => {
    expect(resolveOptions({}).ok).toBe(false)
    expect(resolveOptions({ OPENCODE_SERVER_PASSWORD: "" }).ok).toBe(false)
  })

  test("rejects a non-numeric port", () => {
    const result = resolveOptions({ ...base, OPENCODE_MOBILE_PORT: "abc" })
    expect(result.ok).toBe(false)
  })

  test("rejects an out-of-range port", () => {
    expect(resolveOptions({ ...base, OPENCODE_MOBILE_PORT: "70000" }).ok).toBe(false)
  })

  test("rejects an unparseable upstream", () => {
    expect(resolveOptions({ ...base, OPENCODE_MOBILE_UPSTREAM: "not a url" }).ok).toBe(false)
  })
})

describe("envAuthHeader", () => {
  test("encodes username and password", () => {
    const header = envAuthHeader({
      host: "0.0.0.0",
      port: 4097,
      upstream: "http://127.0.0.1:4096",
      username: "opencode",
      password: "secret",
    })
    expect(header).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
  })
})