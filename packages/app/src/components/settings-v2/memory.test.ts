import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const general = readFileSync(new URL("./general.tsx", import.meta.url), "utf8")
const controllers = readFileSync(new URL("./general-controllers.ts", import.meta.url), "utf8")
const payload = readFileSync(new URL("./memory-payload.ts", import.meta.url), "utf8")
const en = readFileSync(new URL("../../i18n/en.ts", import.meta.url), "utf8")
const fallback = readFileSync(new URL("../../i18n/flynncode-fallback.ts", import.meta.url), "utf8")

const memoryKeys = [
  "settings.memory.section.title",
  "settings.memory.enable.title",
  "settings.memory.enable.description",
  "settings.memory.minTurns.title",
  "settings.memory.minTurns.description",
  "settings.memory.hint",
  "settings.memory.toast.updateFailed.title",
]

describe("settings memory card", () => {
  test("writes the memory config block through the config patch path", () => {
    expect(controllers).toContain("{ memory: memoryToConfig(")
    expect(payload).toContain("min_turns")
  })

  test("payload carries the whole current memory block so sibling keys survive", () => {
    expect(payload).toContain("{ ...current, ...patch }")
  })

  test("general tab wires the memory controller and settings rows", () => {
    expect(general).toContain("createMemorySettingsController")
    expect(general).toContain("data-action=\"settings-memory-enable\"")
    expect(general).toContain("data-action=\"settings-memory-min-turns\"")
  })

  test("copy comes from i18n keys present in en and the flynncode fallback", () => {
    for (const key of memoryKeys) {
      expect(general).toContain(`language.t("${key}")`)
      expect(en).toContain(`"${key}"`)
      expect(fallback).toContain(`"${key}"`)
    }
  })

  test("no label returns a bare i18n key", () => {
    expect(general).not.toMatch(/return "settings\.memory\./)
  })
})
