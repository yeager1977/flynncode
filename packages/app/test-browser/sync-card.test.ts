import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createFolderMissing } from "@/components/prompt-input/folder-missing"
import { createSyncCardController } from "@/components/settings-v2/sync-card-controller"
import type { MachineSyncPlatform, MachineSyncStatus } from "@/context/machine-sync-types"

// Needs the browser build of Solid so effects run:
// bun test --conditions=browser --preload ./happydom.ts ./test-browser/sync-card.test.ts

const base: MachineSyncStatus = {
  paired: false,
  peerName: null,
  paused: false,
  phase: "unpaired",
  online: false,
  lastSuccess: null,
  received: 0,
  sent: 0,
  missingDirectories: [],
  backlog: null,
  failures: [],
  lastError: null,
  gatewayError: null,
  configReloadPending: null,
  machineName: "challenger",
  addresses: ["192.168.1.10"],
}

const paired: MachineSyncStatus = { ...base, paired: true, peerName: "starship", phase: "idle", online: true }

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// A fake desktop bridge: the test pushes statuses the way main would.
function fakeApi(initial: MachineSyncStatus = base) {
  const calls: string[] = []
  const listeners = new Set<(status: MachineSyncStatus) => void>()
  const control = {
    current: initial,
    codeTtl: 600_000,
    fail: false,
    reloadSticks: false,
    held: undefined as (() => void) | undefined,
  }
  const api: MachineSyncPlatform = {
    status: async () => control.current,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    createPairingCode: async () => {
      calls.push("code")
      return { code: "123456", expiresAt: Date.now() + control.codeTtl, machineName: "challenger", addresses: [] }
    },
    pair: async () => ({ ok: true, prefs: "kept" }),
    syncNow: async () => {
      calls.push("syncNow")
      if (control.fail) throw new Error("ipc down")
      await new Promise<void>((resolve) => (control.held = resolve))
      return control.current
    },
    setPaused: async (value) => {
      calls.push(`pause:${value}`)
      if (control.fail) throw new Error("ipc down")
    },
    unpair: async () => {
      calls.push("unpair")
      if (control.fail) throw new Error("ipc down")
    },
    reloadConfig: async () => {
      calls.push("reload")
      if (control.fail) throw new Error("ipc down")
      control.current = {
        ...control.current,
        configReloadPending: control.reloadSticks ? control.current.configReloadPending : null,
      }
      return control.current
    },
    pushPrefs: async () => null,
    onPeerPrefs: () => () => {},
    onAdoptPrefs: () => () => {},
  }
  return {
    api,
    calls,
    control,
    listeners,
    push(status: MachineSyncStatus) {
      control.current = status
      listeners.forEach((cb) => cb(status))
    },
  }
}

describe("createSyncCardController pairing code", () => {
  test("shows the code, then hides it once it has expired", async () => {
    const fake = fakeApi()
    fake.control.codeTtl = 40
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: () => {} })
      await tick()
      sync.showCode()
      await tick()
      expect(sync.code()?.code).toBe("123456")
      await tick(80)
      expect(sync.code()).toBeUndefined()
      dispose()
    })
  })

  test("reports how many minutes the code is valid for", async () => {
    const fake = fakeApi()
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: () => {} })
      sync.showCode()
      await tick()
      expect(sync.code()?.minutes).toBe(10)
      dispose()
    })
  })

  test("clears the code when a paired status arrives and keeps it gone after unpair", async () => {
    const fake = fakeApi()
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: () => {} })
      await tick()
      sync.showCode()
      await tick()
      expect(sync.code()).toBeDefined()
      fake.push(paired)
      await tick()
      expect(sync.code()).toBeUndefined()
      fake.push(base)
      await tick()
      expect(sync.code()).toBeUndefined()
      expect(sync.state.code).toBeUndefined()
      dispose()
    })
  })

  test("unpairing drops any code that was showing", async () => {
    const fake = fakeApi(paired)
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: () => {} })
      await tick()
      sync.unpair()
      await tick()
      expect(fake.calls).toEqual(["unpair"])
      expect(sync.state.code).toBeUndefined()
      dispose()
    })
  })

  test("stops listening to status changes when the card goes away", async () => {
    const fake = fakeApi()
    await createRoot(async (dispose) => {
      createSyncCardController({ api: fake.api, fail: () => {} })
      await tick()
      expect(fake.listeners.size).toBe(1)
      dispose()
    })
    expect(fake.listeners.size).toBe(0)
  })
})

describe("createSyncCardController actions", () => {
  test("a second Sync now while one is running is ignored", async () => {
    const fake = fakeApi(paired)
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: () => {} })
      await tick()
      sync.syncNow()
      sync.syncNow()
      await tick()
      expect(fake.calls).toEqual(["syncNow"])
      expect(sync.state.busy).toBe("syncNow")
      fake.control.held?.()
      await tick()
      expect(sync.state.busy).toBeUndefined()
      dispose()
    })
  })

  test("a manual Sync now that did not finish cleanly toasts", async () => {
    const fake = fakeApi({ ...paired, phase: "offline" })
    const failures: string[] = []
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: (key) => failures.push(key) })
      await tick()
      sync.syncNow()
      await tick()
      fake.control.held?.()
      await tick()
      expect(failures).toEqual(["server.sync.toast.failed"])
      dispose()
    })
  })

  test("failed pause, unpair and sync now are logged and toasted instead of rejecting", async () => {
    const fake = fakeApi(paired)
    fake.control.fail = true
    const failures: string[] = []
    const warn = console.warn
    const logged: unknown[][] = []
    console.warn = (...args: unknown[]) => logged.push(args)
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: (key) => failures.push(key) })
      await tick()
      sync.togglePause()
      await tick()
      sync.unpair()
      await tick()
      sync.syncNow()
      await tick()
      expect(failures).toEqual([
        "server.sync.toast.actionFailed",
        "server.sync.toast.actionFailed",
        "server.sync.toast.failed",
      ])
      expect(sync.state.busy).toBeUndefined()
      dispose()
    })
    console.warn = warn
    expect(logged.length).toBe(3)
  })

  test("pause toggles from the current state", async () => {
    const fake = fakeApi({ ...paired, paused: true })
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: () => {} })
      await tick()
      sync.togglePause()
      await tick()
      expect(fake.calls).toEqual(["pause:false"])
      dispose()
    })
  })

  test("pairing sends the chosen preferences side and surfaces an unreadable result", async () => {
    const fake = fakeApi()
    const sent: unknown[] = []
    fake.api.pair = async (input) => {
      sent.push(input)
      return { ok: true, prefs: "unread" }
    }
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: () => {} })
      sync.set({ host: " starship.local ", pairCode: "654321", prefs: "theirs" })
      sync.pair()
      await tick()
      expect(sent).toEqual([{ host: "starship.local", code: "654321", prefs: "theirs" }])
      expect(sync.state.pairNotice).toBe("server.sync.prefs.unread")
      expect(sync.state.host).toBe("")
      dispose()
    })
  })

  test("without the desktop bridge nothing is loaded", async () => {
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: undefined, fail: () => {} })
      await tick()
      expect(sync.state.status).toBeUndefined()
      sync.showCode()
      sync.unpair()
      expect(sync.code()).toBeUndefined()
      dispose()
    })
  })
})

describe("createSyncCardController reload to apply", () => {
  // Fresh per test: the store merges statuses into the object it was first given.
  const pending = (): MachineSyncStatus => ({ ...paired, configReloadPending: { from: "starship" } })

  test("reloads, clears the pending settings and does not toast", async () => {
    const fake = fakeApi(pending())
    const failures: string[] = []
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: (key) => failures.push(key) })
      await tick()
      expect(sync.state.status?.configReloadPending).toEqual({ from: "starship" })
      sync.reloadConfig()
      expect(sync.state.busy).toBe("reload")
      await tick()
      expect(fake.calls).toEqual(["reload"])
      expect(sync.state.status?.configReloadPending).toBeNull()
      expect(sync.state.busy).toBeUndefined()
      expect(failures).toEqual([])
      dispose()
    })
  })

  test("toasts when the reload fails or leaves the settings pending", async () => {
    const fake = fakeApi(pending())
    const failures: string[] = []
    await createRoot(async (dispose) => {
      const sync = createSyncCardController({ api: fake.api, fail: (key) => failures.push(key) })
      await tick()
      fake.control.reloadSticks = true
      sync.reloadConfig()
      await tick()
      fake.control.fail = true
      sync.reloadConfig()
      await tick()
      expect(failures).toEqual(["server.sync.toast.actionFailed", "server.sync.toast.actionFailed"])
      expect(sync.state.status?.configReloadPending).toEqual({ from: "starship" })
      dispose()
    })
  })
})

describe("createFolderMissing", () => {
  test("is true only when this chat's directory is missing on this machine", async () => {
    const fake = fakeApi({ ...paired, missingDirectories: ["/home/chris/gone"] })
    await createRoot(async (dispose) => {
      const directory = { value: "/home/chris/here" as string | undefined }
      const missing = createFolderMissing({ api: fake.api, directory: () => directory.value })
      await tick()
      expect(missing()).toBe(false)
      fake.push({ ...paired, missingDirectories: ["/home/chris/gone", "/home/chris/here"] })
      await tick()
      expect(missing()).toBe(true)
      fake.push({ ...paired, missingDirectories: [] })
      await tick()
      expect(missing()).toBe(false)
      dispose()
    })
  })

  test("ignores trailing slashes and Windows separators on either side", async () => {
    const fake = fakeApi({ ...paired, missingDirectories: ["C:\\Users\\chris\\gone\\", "/home/chris/gone/"] })
    await createRoot(async (dispose) => {
      const directory = { value: "/home/chris/gone" }
      const missing = createFolderMissing({ api: fake.api, directory: () => directory.value })
      await tick()
      expect(missing()).toBe(true)
      dispose()
    })
    await createRoot(async (dispose) => {
      const missing = createFolderMissing({ api: fake.api, directory: () => "C:/Users/chris/gone" })
      await tick()
      expect(missing()).toBe(true)
      dispose()
    })
  })

  test("is false without a desktop bridge or a directory", async () => {
    const fake = fakeApi({ ...paired, missingDirectories: ["/home/chris/gone"] })
    await createRoot(async (dispose) => {
      const none = createFolderMissing({ api: undefined, directory: () => "/home/chris/gone" })
      const noDirectory = createFolderMissing({ api: fake.api, directory: () => undefined })
      await tick()
      expect(none()).toBe(false)
      expect(noDirectory()).toBe(false)
      dispose()
    })
  })
})
