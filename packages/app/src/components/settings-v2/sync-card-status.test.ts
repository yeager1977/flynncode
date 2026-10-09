import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { MachineSyncStatus } from "@/context/machine-sync-types"
import { dict } from "@/i18n/en"
import { flynncodeFallback } from "@/i18n/flynncode-fallback"
import { syncHeadline, syncNowFailed, syncPairNotice, syncProblem } from "./sync-card-status"

const status: MachineSyncStatus = {
  paired: true,
  peerName: "starship",
  paused: false,
  phase: "idle",
  online: true,
  lastSuccess: 1,
  received: 2,
  sent: 1,
  missingDirectories: [],
  backlog: null,
  failures: [],
  lastError: null,
  gatewayError: null,
  machineName: "challenger",
  addresses: ["192.168.1.10"],
}

describe("syncHeadline", () => {
  test("names the peer and its state", () => {
    expect(syncHeadline(status)).toEqual({ key: "server.sync.online", name: "starship" })
    expect(syncHeadline({ ...status, online: false })).toEqual({ key: "server.sync.offline", name: "starship" })
    expect(syncHeadline({ ...status, paused: true })).toEqual({ key: "server.sync.paused", name: "starship" })
    expect(syncHeadline({ ...status, paired: false, peerName: null })).toEqual({ key: "server.sync.unpaired" })
  })
})

describe("syncProblem", () => {
  test("maps mismatch, 401, failures and other errors to copy", () => {
    expect(syncProblem(status)).toBeUndefined()
    expect(syncProblem({ ...status, phase: "mismatch" })).toEqual({ key: "server.sync.error.mismatch" })
    expect(syncProblem({ ...status, phase: "unauthorized" })).toEqual({ key: "server.sync.error.unauthorized" })
    expect(syncProblem({ ...status, failures: [{ id: "ses_a", error: "422" }] })).toEqual({
      key: "server.sync.error.failures",
      count: 1,
    })
    expect(syncProblem({ ...status, lastError: "settings: 422" })).toEqual({
      key: "server.sync.error.other",
      error: "settings: 422",
    })
  })
})

describe("syncNowFailed", () => {
  test("only a clean idle cycle counts as success", () => {
    expect(syncNowFailed(status)).toBe(false)
    expect(syncNowFailed({ ...status, phase: "offline" })).toBe(true)
    expect(syncNowFailed({ ...status, failures: [{ id: "ses_a", error: "x" }] })).toBe(true)
  })
})

describe("syncPairNotice", () => {
  test("only an unreadable other-computer preference set needs a note", () => {
    expect(syncPairNotice({ ok: true, prefs: "kept" })).toBeUndefined()
    expect(syncPairNotice({ ok: true, prefs: "adopted" })).toBeUndefined()
    expect(syncPairNotice({ ok: true, prefs: "unread" })).toBe("server.sync.prefs.unread")
    expect(syncPairNotice({ ok: false, reason: "unreachable" })).toBeUndefined()
  })
})

describe("sync copy", () => {
  test("every sync key exists in English and in the Flynncode fallback", () => {
    const keys = Object.keys(dict).filter((key) => key.startsWith("server.sync."))
    expect(keys.length).toBe(36)
    expect(dict["server.sync.error.mismatch"]).toBe("Update Flynncode on both machines")
    expect(dict["server.sync.error.unauthorized"]).toBe("Pair again")
    expect(dict["server.sync.prefs.keep"]).toBe("Keep this computer's preferences")
    expect(dict["server.sync.prefs.theirs"]).toBe("Use the other computer's preferences")
    for (const key of keys) expect(Object.hasOwn(flynncodeFallback, key), key).toBe(true)
  })

  test("the card uses the platform API and i18n only", () => {
    const source = readFileSync(new URL("./sync-card.tsx", import.meta.url), "utf8")
    expect(source).toContain("usePlatform().machineSync")
    expect(source).not.toContain("window.api")
    expect(source.match(/>\s*[A-Z][a-z]+[^<{]*</g) ?? []).toEqual([])
    expect(source).toContain("gatewayError")
    expect(source).toContain("prefs: state.prefs")
    const servers = readFileSync(new URL("./servers.tsx", import.meta.url), "utf8")
    expect(servers).toContain("<SyncCard />")
  })
})
