import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { isHttpUrl } from "./phone-relay-url"

const source = readFileSync(new URL("./phone-card.tsx", import.meta.url), "utf8")
const en = readFileSync(new URL("../../i18n/en.ts", import.meta.url), "utf8")
const fallback = readFileSync(new URL("../../i18n/flynncode-fallback.ts", import.meta.url), "utf8")
const relayUrlKeys = [
  "settings.phone.relayUrl.label",
  "settings.phone.relayUrl.hint",
  "settings.phone.relayUrl.placeholder",
  "settings.phone.relayUrl.save",
  "settings.phone.relayUrl.saved",
  "settings.phone.relayUrl.invalid",
]

describe("phone launcher url", () => {
  test("launcher url ends with /m", () => {
    expect("http://192.168.1.42:4097/m".endsWith("/m")).toBe(true)
  })

  test("relay url row reads and writes the settings store", () => {
    expect(source).toContain('storeGet?.("opencode.settings", "relayPublishUrl")')
    expect(source).toContain('storeSet?.("opencode.settings", "relayPublishUrl"')
  })

  test("relay url save validates http(s) input and toasts invalid input", () => {
    expect(source).toContain("isHttpUrl(value)")
    expect(source).toContain('showToast({ variant: "error", description: language.t("settings.phone.relayUrl.invalid") })')
  })

  test("relay token and url saves push the config to the running sidecar", () => {
    expect(source).toContain("setRelayConfig?.({ remoteToken: value })")
    expect(source).toContain("setRelayConfig?.({ url: value })")
  })

  test("relay url validation accepts http(s) gateway hosts and rejects other schemes", () => {
    expect(isHttpUrl("https://deepthought:4097/m")).toBe(true)
    expect(isHttpUrl("https://192.168.4.251")).toBe(true)
    expect(isHttpUrl("http://127.0.0.1:4097/m")).toBe(true)
    expect(isHttpUrl("https://host.tailnet-name.ts.net")).toBe(true)
    expect(isHttpUrl("ftp://deepthought:4097/m")).toBe(false)
    expect(isHttpUrl("deepthought:4097/m")).toBe(false)
    expect(isHttpUrl("https://")).toBe(false)
    expect(isHttpUrl("")).toBe(false)
  })

  test("relay url copy exists in en and the flynncode fallback and notes the restart", async () => {
    for (const key of relayUrlKeys) {
      expect(en.includes(key), key).toBe(true)
      expect(fallback.includes(key), key).toBe(true)
    }
    const { dict } = (await import("@/i18n/en")) as Record<string, Record<string, string>>
    expect(dict["settings.phone.relayUrl.hint"].toLowerCase()).toContain("restart")
    expect(dict["settings.phone.relayUrl.saved"].toLowerCase()).toContain("restart")
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
