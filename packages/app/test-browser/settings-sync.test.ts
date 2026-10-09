import { describe, expect, test } from "bun:test"
import { batch, createEffect, createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { MachineSyncPrefs } from "@/context/machine-sync-types"
import type { Settings } from "@/context/settings"
import { createSettingsSync, syncableSections } from "@/context/settings-sync"

// Needs the browser build of Solid so the change-detection effect actually
// runs: bun test --conditions=browser --preload ./happydom.ts ./test-browser
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

describe("createSettingsSync", () => {
  type Pushed = { sections: Record<string, unknown>; updatedAt: number }

  // A real Solid store and effect, with a fake desktop that records pushes.
  function setup(input?: { ready?: boolean; reply?: MachineSyncPrefs | null; stamp?: number }) {
    const pushed: Pushed[] = []
    const errors: unknown[] = []
    const clock = { now: 1_000 }
    const ready = createSignal(input?.ready ?? true)
    const reply = { value: input?.reply ?? null, fail: false }
    const [store, setStore] = createStore<Settings>({
      ...structuredClone(settings),
      syncUpdatedAt: input?.stamp ?? 5,
    })
    const sync = createSettingsSync({
      platform: {
        pushPrefs: async (prefs) => {
          pushed.push(structuredClone(prefs))
          if (reply.fail) throw new Error("ipc down")
          return reply.value
        },
      },
      ready: ready[0],
      read: () => store,
      write: (sections, updatedAt) =>
        batch(() => {
          if (sections.general) setStore("general", reconcile(sections.general))
          if (sections.appearance) setStore("appearance", reconcile(sections.appearance))
          if (sections.keybinds) setStore("keybinds", reconcile(sections.keybinds))
          if (sections.notifications) setStore("notifications", reconcile(sections.notifications))
          if (sections.sounds) setStore("sounds", reconcile(sections.sounds))
          setStore("syncUpdatedAt", updatedAt)
        }),
      now: () => clock.now,
      onError: (error) => errors.push(error),
    })
    const dispose = createRoot((dispose) => {
      createEffect(sync.check)
      return dispose
    })
    return { pushed, errors, clock, store, setStore, sync, setReady: ready[1], reply, dispose }
  }

  const peerPrefs = (updatedAt: number, patch?: Record<string, unknown>): MachineSyncPrefs => ({
    updatedAt,
    sections: {
      ...syncableSections(settings),
      appearance: { fontSize: 18, mono: "Iosevka", sans: "", terminal: "" },
      ...patch,
    },
  })

  test("pushes the first snapshot with the stored stamp and leaves the stamp alone", () => {
    const { pushed, store, dispose } = setup()
    expect(pushed).toHaveLength(1)
    expect(pushed[0].updatedAt).toBe(5)
    expect(store.syncUpdatedAt).toBe(5)
    dispose()
  })

  test("a local edit of a synced section stamps now and pushes", () => {
    const { pushed, store, setStore, clock, dispose } = setup()
    clock.now = 2_000
    setStore("appearance", "fontSize", 20)
    expect(store.syncUpdatedAt).toBe(2_000)
    expect(pushed).toHaveLength(2)
    expect(pushed[1].updatedAt).toBe(2_000)
    expect((pushed[1].sections.appearance as { fontSize: number }).fontSize).toBe(20)
    dispose()
  })

  test("editing a launch-state flag, permissions or cleanup neither stamps nor pushes", () => {
    const { pushed, store, setStore, clock, dispose } = setup()
    clock.now = 2_000
    setStore("general", "newLayoutDesigns", false)
    setStore("general", "shouldDisplayTabsToast", false)
    setStore("permissions", "autoApprove", false)
    setStore("cleanup", "autoArchiveAfterPrClose", false)
    expect(store.syncUpdatedAt).toBe(5)
    expect(pushed).toHaveLength(1)
    dispose()
  })

  test("a newer peer replaces synced sections, keeps local flags, takes its stamp and does not bounce", () => {
    const { pushed, store, sync, clock, dispose } = setup()
    clock.now = 2_000
    sync.applyPeer(
      peerPrefs(9, {
        general: { ...(syncableSections(settings).general as object), showTerminal: false, newLayoutDesigns: false },
      }),
    )
    expect(store.appearance.fontSize).toBe(18)
    expect(store.general.showTerminal).toBe(false)
    expect(store.general.newLayoutDesigns).toBe(true)
    expect(store.syncUpdatedAt).toBe(9)
    expect(pushed).toHaveLength(1)
    dispose()
  })

  test("an edit after a peer apply still stamps and pushes", () => {
    const { pushed, store, setStore, sync, clock, dispose } = setup()
    sync.applyPeer(peerPrefs(9))
    clock.now = 3_000
    setStore("appearance", "fontSize", 21)
    expect(store.syncUpdatedAt).toBe(3_000)
    expect(pushed).toHaveLength(2)
    dispose()
  })

  test("older or equal peer stamps are ignored", () => {
    const { pushed, store, sync, dispose } = setup()
    sync.applyPeer(peerPrefs(5))
    sync.applyPeer(peerPrefs(4))
    expect(store.appearance.fontSize).toBe(14)
    expect(store.syncUpdatedAt).toBe(5)
    expect(pushed).toHaveLength(1)
    dispose()
  })

  test("peer prefs arriving before the store is ready are not applied", () => {
    const { pushed, store, sync, dispose } = setup({ ready: false })
    sync.applyPeer(peerPrefs(9))
    expect(store.appearance.fontSize).toBe(14)
    expect(store.syncUpdatedAt).toBe(5)
    expect(pushed).toHaveLength(0)
    dispose()
  })

  test("the push reply carries newer prefs from the desktop and they are applied without a push", async () => {
    const { pushed, store, dispose } = setup({ reply: peerPrefs(9) })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.appearance.fontSize).toBe(18)
    expect(store.syncUpdatedAt).toBe(9)
    expect(pushed).toHaveLength(1)
    dispose()
  })

  test("a push failure is reported, not swallowed", async () => {
    const { errors, setStore, reply, dispose } = setup()
    reply.fail = true
    setStore("appearance", "fontSize", 22)
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    dispose()
  })

  test("adopting null keeps this computer's prefs, restamped now, and pushes them", () => {
    const { pushed, store, sync, clock, dispose } = setup()
    clock.now = 4_000
    sync.adopt(null)
    expect(store.syncUpdatedAt).toBe(4_000)
    expect(store.appearance.fontSize).toBe(14)
    expect(pushed).toHaveLength(2)
    expect(pushed[1].updatedAt).toBe(4_000)
    dispose()
  })

  test("adopting the peer's prefs applies them with a fresh stamp (even if older) and pushes once", () => {
    const { pushed, store, sync, clock, dispose } = setup({ stamp: 50 })
    clock.now = 4_000
    sync.adopt(peerPrefs(7))
    expect(store.appearance.fontSize).toBe(18)
    expect(store.general.newLayoutDesigns).toBe(true)
    expect(store.syncUpdatedAt).toBe(4_000)
    expect(pushed).toHaveLength(2)
    expect(pushed[1].updatedAt).toBe(4_000)
    expect((pushed[1].sections.appearance as { fontSize: number }).fontSize).toBe(18)
    dispose()
  })

  test("adopt is ignored before the store is ready", () => {
    const { pushed, store, sync, dispose } = setup({ ready: false })
    sync.adopt(peerPrefs(7))
    expect(store.appearance.fontSize).toBe(14)
    expect(pushed).toHaveLength(0)
    dispose()
  })

  test("pushes the first snapshot once the store becomes ready", () => {
    const { pushed, setReady, dispose } = setup({ ready: false })
    expect(pushed).toHaveLength(0)
    setReady(true)
    expect(pushed).toHaveLength(1)
    dispose()
  })
})
