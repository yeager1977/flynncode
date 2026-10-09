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
  configReloadPending: null,
  machineName: "challenger",
  addresses: ["192.168.1.10"],
}

describe("syncHeadline", () => {
  test("names the peer and its state", () => {
    expect(syncHeadline(status)).toEqual({ key: "server.sync.online", name: "starship" })
    expect(syncHeadline({ ...status, online: false })).toEqual({ key: "server.sync.offline", name: "starship" })
    expect(syncHeadline({ ...status, paused: true })).toEqual({ key: "server.sync.paused", name: "starship" })
    expect(syncHeadline({ ...status, phase: "peer-paused", online: true })).toEqual({
      key: "server.sync.peerPaused",
      name: "starship",
    })
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

describe("syncProblem clock skew", () => {
  test("says the clocks differ instead of asking to pair again", () => {
    expect(syncProblem({ ...status, phase: "clock-skew" })).toEqual({ key: "server.sync.error.clock" })
    expect(dict["server.sync.error.clock"]).toContain("clocks")
  })
})

describe("syncNowFailed", () => {
  test("only a clean idle cycle counts as success", () => {
    expect(syncNowFailed(status)).toBe(false)
    expect(syncNowFailed({ ...status, phase: "offline" })).toBe(true)
    expect(syncNowFailed({ ...status, failures: [{ id: "ses_a", error: "x" }] })).toBe(true)
    // The other computer paused sync: the headline says so, no "Sync failed" toast.
    expect(syncNowFailed({ ...status, phase: "peer-paused" })).toBe(false)
    expect(syncNowFailed({ ...status, phase: "clock-skew" })).toBe(true)
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
  // Every server.sync.* key the card, its controller and the composer use must
  // have English copy and be listed in the Flynncode fallback.
  const used = [
    "./sync-card.tsx",
    "./sync-card-controller.ts",
    "./sync-card-status.ts",
    "../prompt-input-v2.tsx",
  ].flatMap(
    (file) => readFileSync(new URL(file, import.meta.url), "utf8").match(/server\.sync\.[A-Za-z.-]+[A-Za-z]/g) ?? [],
  )

  test("every sync key in use exists in English and in the Flynncode fallback", () => {
    const keys = [...new Set(used)]
    expect(keys.length).toBeGreaterThan(20)
    for (const key of keys) {
      expect(Object.hasOwn(dict, key), `${key} in en`).toBe(true)
      expect(Object.hasOwn(flynncodeFallback, key), `${key} in fallback`).toBe(true)
    }
  })

  test("every English sync key is in the fallback and key copy is as specified", () => {
    for (const key of Object.keys(dict).filter((key) => key.startsWith("server.sync.")))
      expect(Object.hasOwn(flynncodeFallback, key), key).toBe(true)
    expect(dict["server.sync.error.mismatch"]).toBe("Update Flynncode on both machines")
    expect(dict["server.sync.error.unauthorized"]).toBe("Pair again")
    expect(dict["server.sync.prefs.keep"]).toBe("Keep this computer's preferences")
    expect(dict["server.sync.prefs.theirs"]).toBe("Use the other computer's preferences")
    expect(dict["server.sync.code.hint"]).toContain("{{minutes}}")
    // The code can have one minute left; "1 minutes" must never be shown.
    expect(dict["server.sync.code.hint"].replace("{{minutes}}", "1")).not.toContain("1 minutes")
    expect(dict["server.sync.peerPaused"]).toBe("Paused on {{name}}")
  })

  test("the card keeps no hardcoded English in its markup and is mounted in Servers", () => {
    const source = readFileSync(new URL("./sync-card.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("window.api")
    expect(source.match(/>\s*[A-Z][a-z]+[^<{]*</g) ?? []).toEqual([])
    expect(readFileSync(new URL("./servers.tsx", import.meta.url), "utf8")).toContain("<SyncCard />")
  })
})
