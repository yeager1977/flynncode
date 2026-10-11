import { describe, expect, test } from "bun:test"
import {
  createReconciler,
  gatewayWanted,
  isSyncMessage,
  overlayRelaySettings,
  parsePrefs,
  parseRelayConfig,
  parseSyncCommand,
  parseSyncStart,
  shutdown,
} from "./sidecar-sync"

const peer = { name: "starship", url: "http://192.168.1.20:4097", token: "a".repeat(64) }

describe("parseSyncStart", () => {
  test("accepts an unpaired machine with phone access off", () => {
    expect(parseSyncStart({ machineName: "challenger", phoneAccess: false, paused: false, peer: null, prefs: null })).toEqual({
      machineName: "challenger",
      phoneAccess: false,
      paused: false,
      peer: null,
      prefs: null,
    })
  })

  test("keeps a well-formed peer and prefs", () => {
    const prefs = { sections: { appearance: { fontSize: 15 } }, updatedAt: 3 }
    expect(parseSyncStart({ machineName: "challenger", phoneAccess: true, paused: true, peer, prefs })).toEqual({
      machineName: "challenger",
      phoneAccess: true,
      paused: true,
      peer,
      prefs,
    })
  })

  test("rejects malformed settings", () => {
    expect(parseSyncStart(undefined)).toBeUndefined()
    expect(parseSyncStart({ machineName: "x", phoneAccess: "yes", paused: false, peer: null, prefs: null })).toBeUndefined()
    expect(parseSyncStart({ machineName: "x", phoneAccess: true, paused: false, peer: { name: "x" }, prefs: null })).toBeUndefined()
    expect(parsePrefs({ sections: [], updatedAt: 1 })).toBeUndefined()
  })
})

describe("parseSyncCommand", () => {
  test("parses every command and ignores the start/stop protocol", () => {
    expect(parseSyncCommand({ type: "sync-config", phoneAccess: true, paused: false, peer: null })).toEqual({
      type: "sync-config",
      phoneAccess: true,
      paused: false,
      peer: null,
    })
    expect(parseSyncCommand({ type: "sync-pairing-code", code: "123456", expiresAt: 5 })).toEqual({
      type: "sync-pairing-code",
      code: "123456",
      expiresAt: 5,
    })
    expect(parseSyncCommand({ type: "sync-now", requestID: "r1" })).toEqual({ type: "sync-now", requestID: "r1" })
    expect(parseSyncCommand({ type: "sync-prefs", prefs: { sections: {}, updatedAt: 1 } })).toEqual({
      type: "sync-prefs",
      prefs: { sections: {}, updatedAt: 1 },
    })
    expect(parseSyncCommand({ type: "stop" })).toBeUndefined()
    expect(parseSyncCommand({ type: "sync-pairing-code", code: 123456, expiresAt: 5 })).toBeUndefined()
  })
})

describe("parseRelayConfig", () => {
  test("parses a command that carries every field", () => {
    const url = "https://deepthought:4097/m"
    expect(parseSyncCommand({ type: "relay-config", token: "t", remoteToken: "r", url })).toEqual({
      type: "relay-config",
      token: "t",
      remoteToken: "r",
      url,
    })
  })

  test("keeps field absence instead of widening it to empty values", () => {
    expect(parseSyncCommand({ type: "relay-config", url: "https://deepthought:4097/m" })).toEqual({
      type: "relay-config",
      url: "https://deepthought:4097/m",
    })
    expect(parseRelayConfig({ type: "relay-config", remoteToken: "r" })).toEqual({ remoteToken: "r" })
  })

  test("ignores non-string and empty fields, and a command with none of them", () => {
    expect(parseSyncCommand({ type: "relay-config", token: "t", remoteToken: "", url: 1 })).toEqual({
      type: "relay-config",
      token: "t",
    })
    expect(parseRelayConfig({ type: "relay-config", remoteToken: "" })).toBeUndefined()
    expect(parseRelayConfig({ type: "relay-config" })).toBeUndefined()
    expect(parseRelayConfig({ type: "relay-config", url: null })).toBeUndefined()
  })
})

describe("overlayRelaySettings", () => {
  const current = { token: "t0", remoteToken: "r0", url: "https://old:4097/m" }

  test("overlays only the provided fields and keeps the rest", () => {
    expect(overlayRelaySettings(current, { url: "https://new:4097/m" }, {})).toEqual({
      token: "t0",
      remoteToken: "r0",
      url: "https://new:4097/m",
    })
    expect(overlayRelaySettings(current, { token: "t1", remoteToken: "r1", url: "u1" }, {})).toEqual({
      token: "t1",
      remoteToken: "r1",
      url: "u1",
    })
  })

  test("preserves everything when nothing usable is provided (no clearing)", () => {
    expect(overlayRelaySettings(current, {}, {})).toEqual(current)
    expect(overlayRelaySettings(current, { token: "", remoteToken: "", url: "" }, {})).toEqual(current)
  })

  test("env-provided values keep the precedence they had at start", () => {
    expect(overlayRelaySettings(current, { url: "https://new:4097/m" }, { OPENCODE_RELAY_URL: "https://env:4097/m" })).toEqual(current)
    expect(overlayRelaySettings(current, { remoteToken: "r1" }, { OPENCODE_RELAY_REMOTE_TOKEN: "r0" })).toEqual({
      token: "t0",
      remoteToken: "r0",
      url: "https://old:4097/m",
    })
    // Each field is gated by its own env key.
    expect(overlayRelaySettings(current, { token: "t1", url: "u1" }, { OPENCODE_RELAY_REMOTE_TOKEN: "r0" })).toEqual({
      token: "t1",
      remoteToken: "r0",
      url: "u1",
    })
  })
})

describe("isSyncMessage", () => {
  test("recognises sidecar sync messages only", () => {
    expect(isSyncMessage({ type: "sync-paired", peer })).toBe(true)
    expect(isSyncMessage({ type: "sync-unpaired" })).toBe(true)
    expect(parseSyncCommand({ type: "sync-reload", requestID: "r1" })).toEqual({
      type: "sync-reload",
      requestID: "r1",
      force: false,
    })
    expect(parseSyncCommand({ type: "sync-reload", requestID: "r2", force: true })).toEqual({
      type: "sync-reload",
      requestID: "r2",
      force: true,
    })
    expect(parseSyncCommand({ type: "sync-reload" })).toBeUndefined()
    expect(isSyncMessage({ type: "sync-peer-moved", peer })).toBe(true)
    expect(isSyncMessage({ type: "sync-peer-moved", peer: { name: "x" } })).toBe(false)
    expect(isSyncMessage({ type: "sync-status", status: { phase: "idle" } })).toBe(true)
    expect(isSyncMessage({ type: "sync-peer-prefs", prefs: { sections: {}, updatedAt: 1 } })).toBe(true)
    expect(isSyncMessage({ type: "sync-gateway", error: null })).toBe(true)
    expect(isSyncMessage({ type: "sync-gateway", error: "port busy" })).toBe(true)
    expect(isSyncMessage({ type: "sync-gateway", error: 1 })).toBe(false)
    expect(isSyncMessage({ type: "ready" })).toBe(false)
    expect(isSyncMessage({ type: "sync-paired", peer: {} })).toBe(false)
  })
})

describe("gatewayWanted", () => {
  test("stays off with phone access off and nothing paired", () => {
    expect(gatewayWanted({ phoneAccess: false, peer: undefined, pairingActive: false })).toBe(false)
  })

  test("runs for phone access, a paired peer, or a waiting pairing code", () => {
    expect(gatewayWanted({ phoneAccess: true, peer: undefined, pairingActive: false })).toBe(true)
    expect(gatewayWanted({ phoneAccess: false, peer, pairingActive: false })).toBe(true)
    expect(gatewayWanted({ phoneAccess: false, peer: undefined, pairingActive: true })).toBe(true)
  })
})

describe("createReconciler", () => {
  test("a throwing apply is reported and neither rejects nor blocks later runs", async () => {
    const errors: unknown[] = []
    const runs: number[] = []
    let calls = 0
    const reconcile = createReconciler(
      async () => {
        calls += 1
        runs.push(calls)
        if (calls === 1) throw new Error("boom")
      },
      (error) => errors.push(error),
    )
    await expect(reconcile()).resolves.toBeUndefined()
    await expect(reconcile()).resolves.toBeUndefined()
    expect(runs).toEqual([1, 2])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe("boom")
  })

  test("serialises overlapping calls", async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const reconcile = createReconciler(
      async () => {
        calls += 1
        const id = calls
        order.push(`start${id}`)
        if (id === 1) await gate
        order.push(`end${id}`)
      },
      () => {},
    )
    const first = reconcile()
    const second = reconcile()
    await Promise.resolve()
    expect(order).toEqual(["start1"])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(["start1", "end1", "start2", "end2"])
  })
})

describe("shutdown", () => {
  test("runs every step even when earlier ones throw or reject", async () => {
    const ran: string[] = []
    const failed: string[] = []
    await shutdown(
      [
        {
          name: "gateway",
          run: () => {
            ran.push("gateway")
            throw new Error("gateway stop threw")
          },
        },
        {
          name: "relay",
          run: async () => {
            ran.push("relay")
            throw new Error("relay stop rejected")
          },
        },
        { name: "instances", run: async () => void ran.push("instances") },
        { name: "listener", run: () => void ran.push("listener") },
      ],
      (name) => failed.push(name),
    )
    expect(ran).toEqual(["gateway", "relay", "instances", "listener"])
    expect(failed).toEqual(["gateway", "relay"])
  })
})
