import { describe, expect, test } from "bun:test"
import { ConfigPreview } from "../../src/config/preview"

const parse = (input: unknown) => ConfigPreview.settings(input as never)

// Wraps entries so settings() sees the tolerant preview tunnel shape.
const withPreview = (servers: unknown, autoVerify?: boolean) => ({
  preview: { servers, ...(autoVerify !== undefined ? { autoVerify } : {}) },
})

describe("ConfigPreview.settings", () => {
  test("absent preview yields no servers and default autoVerify", () => {
    expect(parse({})).toEqual({ value: { servers: [], autoVerify: true, nativeHost: false }, warnings: [] })
  })

  test("managed server with command and args passes through", () => {
    const result = parse(withPreview([{ name: "web", command: "bun", args: ["dev"], cwd: "app", autoPort: false }]))
    expect(result.warnings).toEqual([])
    expect(result.value.servers).toEqual([
      { name: "web", command: "bun", args: ["dev"], cwd: "app", autoPort: false },
    ])
  })

  test("attach-only server with valid localhost origin passes through", () => {
    const result = parse(withPreview([{ name: "docs", url: "http://localhost:4000/" }]))
    expect(result.warnings).toEqual([])
    expect(result.value.servers[0].url).toBe("http://localhost:4000/")
  })

  test("both command and url is a managed server using config url", () => {
    const result = parse(withPreview([{ name: "x", command: "bun dev", url: "http://localhost:3000" }]))
    expect(result.warnings).toEqual([])
    expect(result.value.servers[0]).toMatchObject({ command: "bun dev", url: "http://localhost:3000/" })
  })

  test("entry without command or url is skipped with a warning", () => {
    const result = parse(withPreview([{ name: "empty" }]))
    expect(result.value.servers).toEqual([])
    expect(result.warnings.join("\n")).toContain('needs "command" (managed) or "url" (attach-only)')
  })

  test("non-http URL is skipped", () => {
    const result = parse(withPreview([{ name: "ftp", url: "ftp://localhost:21" }]))
    expect(result.value.servers).toEqual([])
    expect(result.warnings.join("\n")).toContain("must use http or https")
  })

  test("URL with userinfo is skipped", () => {
    const result = parse(withPreview([{ name: "credentialed", url: "http://user:pass@localhost:4000" }]))
    expect(result.value.servers).toEqual([])
    expect(result.warnings.join("\n")).toContain("userinfo")
  })

  test("localhost URL with a path is rejected", () => {
    const result = parse(withPreview([{ name: "pathed", url: "http://localhost:4000/app" }]))
    expect(result.value.servers).toEqual([])
    expect(result.warnings.join("\n")).toContain("origin-only")
  })

  test("localhost URL without a port is rejected", () => {
    const result = parse(withPreview([{ name: "portless", url: "http://localhost/" }]))
    expect(result.value.servers).toEqual([])
    expect(result.warnings.join("\n")).toContain("explicit port")
  })

  test("localhost URL port must match the declared port", () => {
    const result = parse(withPreview([{ name: "mismatch", url: "http://localhost:4000", port: 5000 }]))
    expect(result.value.servers).toEqual([])
    expect(result.warnings.join("\n")).toContain("does not match the declared port 5000")
  })

  test("matching port and URL is accepted", () => {
    const result = parse(withPreview([{ name: "ok", url: "http://127.0.0.1:4000", port: 4000 }]))
    expect(result.warnings).toEqual([])
    expect(result.value.servers[0].url).toBe("http://127.0.0.1:4000/")
  })

  test("duplicate names are skipped", () => {
    const result = parse(withPreview([{ name: "a", command: "x" }, { name: "a", command: "y" }]))
    expect(result.value.servers).toHaveLength(1)
    expect(result.warnings.join("\n")).toContain("duplicate name")
  })

  test("missing name is skipped", () => {
    const result = parse(withPreview([{ command: "x" }]))
    expect(result.value.servers).toEqual([])
    expect(result.warnings.join("\n")).toContain("missing name")
  })

  test("non-object entry skipped; invalid args dropped but server kept", () => {
    const result = parse(withPreview(["nope", { name: "argsy", command: "x", args: [1, "two"] }]))
    expect(result.value.servers).toEqual([{ name: "argsy", command: "x" }])
    expect(result.warnings.join("\n")).toContain("entry is not an object")
  })

  test("malformed top-level values degrade without failing", () => {
    expect(parse({ preview: { servers: "many" } }).value.servers).toEqual([])
    expect(parse({ preview: "garbage" }).value.servers).toEqual([])
    expect(parse({ preview: { servers: [42] } }).value.servers).toEqual([])
  })

  test("autoVerify defaults to true and respects config and per-server overrides", () => {
    expect(parse({ preview: {} }).value.autoVerify).toBe(true)
    expect(parse(withPreview([], false)).value.autoVerify).toBe(false)
    expect(parse(withPreview([], true)).value.autoVerify).toBe(true)
  })

  test("nativeHost defaults to false and only accepts booleans", () => {
    expect(parse({}).value.nativeHost).toBe(false)
    expect(parse({ preview: {} }).value.nativeHost).toBe(false)
    expect(parse({ preview: { nativeHost: true } }).value.nativeHost).toBe(true)
    expect(parse({ preview: { nativeHost: false } }).value.nativeHost).toBe(false)
    expect(parse({ preview: { nativeHost: "yes" } }).value.nativeHost).toBe(false)
    expect(parse({ preview: { nativeHost: 1 } }).value.nativeHost).toBe(false)
  })

  test("per-server autoVerify passes through", () => {
    const result = parse(withPreview([{ name: "a", command: "x", autoVerify: false }]))
    expect(result.value.servers[0].autoVerify).toBe(false)
  })

  test("invalid port value is dropped and no longer matches the URL port", () => {
    const result = parse(withPreview([{ name: "bad", url: "http://localhost:4000", port: -1 }]))
    // -1 is not a valid port → dropped; 127.0.0.1 URL remains valid on its own
    expect(result.value.servers).toEqual([{ name: "bad", url: "http://localhost:4000/" }])
    expect(result.warnings.join("\n")).not.toContain("does not match")
  })

  test("autoPort on an attach-only server warns but keeps the server", () => {
    const result = parse(withPreview([{ name: "a", url: "http://localhost:4000", autoPort: true }]))
    expect(result.value.servers).toHaveLength(1)
    expect(result.warnings.join("\n")).toContain("autoPort ignored for attach-only server")
  })
})
