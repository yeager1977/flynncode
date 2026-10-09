import { describe, expect, test } from "bun:test"
import { gatewayWanted, isSyncMessage, parsePrefs, parseSyncCommand, parseSyncStart } from "./sidecar-sync"

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

describe("isSyncMessage", () => {
  test("recognises sidecar sync messages only", () => {
    expect(isSyncMessage({ type: "sync-paired", peer })).toBe(true)
    expect(isSyncMessage({ type: "sync-unpaired" })).toBe(true)
    expect(isSyncMessage({ type: "sync-status", status: { phase: "idle" } })).toBe(true)
    expect(isSyncMessage({ type: "sync-peer-prefs", prefs: { sections: {}, updatedAt: 1 } })).toBe(true)
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
