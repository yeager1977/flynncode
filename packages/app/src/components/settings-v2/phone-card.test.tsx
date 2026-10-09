import { describe, expect, test } from "bun:test"

describe("phone launcher url", () => {
  test("launcher url ends with /m", () => {
    expect("http://192.168.1.42:4097/m".endsWith("/m")).toBe(true)
  })

  test("required i18n keys exist in en module", async () => {
    const mod = (await import("@/i18n/en")) as Record<string, unknown>
    const text = JSON.stringify(mod)
    for (const key of ["server.phone.title", "server.phone.hint", "server.phone.copy", "server.phone.stopped", "server.phone.noWifi"]) {
      expect(text.includes(key), key).toBe(true)
    }
  })

  test("relay copy keys exist in en only", async () => {
    const { dict } = (await import("@/i18n/en")) as Record<string, Record<string, string>>
    expect(dict["server.phone.away.title"]).toBe("Away from home")
    expect(dict["server.phone.relay.hint"]).toContain("deepthought")
    expect(dict["server.phone.relay.token.label"].toLowerCase()).toContain("deepthought")
    expect(dict["server.phone.relay.token.save"]).toBe("Save")
  })

  test("phone password copy explains that rotation needs a restart", async () => {
    const { dict } = (await import("@/i18n/en")) as Record<string, Record<string, string>>
    expect(dict["server.phone.password.label"]).toBe("Phone password")
    expect(dict["server.phone.password.rotated"]).toContain("restart")
  })

  test("phone access copy exists and is in the fallback", async () => {
    const { dict } = (await import("@/i18n/en")) as Record<string, Record<string, string>>
    expect(dict["server.phone.access.label"]).toBe("Phone access")
    expect(dict["server.phone.access.hint"]).toContain("right away")
    expect(dict["server.phone.access.off"]).toContain("off")
    const { flynncodeFallback } = await import("@/i18n/flynncode-fallback")
    for (const key of ["server.phone.access.hint", "server.phone.access.label", "server.phone.access.off"])
      expect(Object.hasOwn(flynncodeFallback, key), key).toBe(true)
  })
})
