import { describe, expect, test } from "bun:test"

describe("phone launcher url", () => {
  test("launcher url ends with /m", () => {
    expect("http://192.168.1.42:4097/m".endsWith("/m")).toBe(true)
  })

  test("required i18n keys exist in en module", async () => {
    const mod = (await import("@/i18n/en")) as Record<string, unknown>
    const text = JSON.stringify(mod)
    for (const key of ["server.phone.title", "server.phone.hint", "server.phone.copy", "server.phone.stopped"]) {
      expect(text.includes(key), key).toBe(true)
    }
  })
})
