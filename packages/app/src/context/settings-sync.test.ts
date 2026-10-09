import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Settings } from "./settings"
import { mergePeerSections, syncableSections, syncKey } from "./settings-sync"

const settings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: false,
    followup: "steer",
    showFileTree: true,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: true,
    showReasoningSummaries: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showCustomAgents: false,
    mobileTitlebarPosition: "top",
    newLayoutDesigns: true,
    layoutTransitionEligible: false,
    shouldDisplayTabsToast: true,
  },
  appearance: { fontSize: 14, mono: "", sans: "", terminal: "" },
  keybinds: { "file.attach": "mod+u" },
  permissions: { autoApprove: true },
  cleanup: { autoArchiveAfterPrClose: true },
  notifications: { agent: true, permissions: true, errors: false },
  sounds: {
    agentEnabled: true,
    agent: "a",
    permissionsEnabled: true,
    permissions: "b",
    errorsEnabled: false,
    errors: "c",
  },
  syncUpdatedAt: 5,
}

describe("syncableSections", () => {
  test("keeps the five synced sections and drops launch-state flags, permissions and cleanup", () => {
    const sections = syncableSections(settings)
    expect(Object.keys(sections).sort()).toEqual(["appearance", "general", "keybinds", "notifications", "sounds"])
    expect(sections.general).not.toHaveProperty("newLayoutDesigns")
    expect(sections.general).not.toHaveProperty("layoutTransitionEligible")
    expect(sections.general).not.toHaveProperty("shouldDisplayTabsToast")
    expect(sections.general).toHaveProperty("showTerminal", true)
  })
})

describe("syncKey", () => {
  test("ignores key order", () => {
    expect(syncKey({ a: { x: 1, y: 2 }, b: [1, { c: 3, d: 4 }] })).toBe(
      syncKey({ b: [1, { d: 4, c: 3 }], a: { y: 2, x: 1 } }),
    )
  })
})

describe("mergePeerSections", () => {
  test("takes the peer's sections but keeps this install's launch-state flags", () => {
    const merged = mergePeerSections(settings, {
      updatedAt: 9,
      sections: {
        general: {
          ...(syncableSections(settings).general as Record<string, unknown>),
          showTerminal: false,
          newLayoutDesigns: false,
        },
        appearance: { fontSize: 18, mono: "Iosevka", sans: "", terminal: "" },
        keybinds: {},
      },
    })
    expect(merged.general?.showTerminal).toBe(false)
    expect(merged.general?.newLayoutDesigns).toBe(true)
    expect(merged.general?.shouldDisplayTabsToast).toBe(true)
    expect(merged.appearance?.fontSize).toBe(18)
    expect(merged.keybinds).toEqual({})
    expect(merged.sounds).toBeUndefined()
  })
})

describe("settings provider wiring", () => {
  test("hands the platform to the sync controller", () => {
    const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8")
    expect(source).toContain("createSettingsSync(")
    expect(source).toContain("machineSync.onPeerPrefs(")
    expect(source).toContain("machineSync.onAdoptPrefs(")
  })
})
