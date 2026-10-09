import { afterEach, describe, expect, test } from "bun:test"
import { createGateway } from "@flynncode/mobile-gateway/gateway"
import { createSyncGate } from "@flynncode/mobile-gateway/sync-gate"
import { initialStatus } from "@flynncode/mobile-gateway/sync"
import { createMachineSync, parsePairInput, readSyncStart, type SyncStore } from "./machine-sync"
import type { SidecarSyncCommand } from "./sidecar-sync"

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  while (servers.length) servers.pop()?.stop(true)
})

function memoryStore() {
  const values = new Map<string, unknown>()
  const store: SyncStore = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
    },
    delete: (key) => {
      values.delete(key)
    },
  }
  return { values, store }
}

function controller() {
  const memory = memoryStore()
  const posted: SidecarSyncCommand[] = []
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  const sync = createMachineSync({
    store: memory.store,
    machineName: "starship",
    post: (command) => posted.push(command),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    lanAddresses: () => ["192.168.1.20"],
    now: () => 1_000,
    code: () => "123456",
  })
  return { values: memory.values, posted, broadcasts, sync }
}

// Machine A: a real gateway with a pairing code, as the other computer.
function peerMachine(prefs?: { sections: Record<string, unknown>; updatedAt: number }) {
  const gate = createSyncGate({
    machineName: "challenger",
    gatewayPort: 4097,
    phoneAccess: false,
    paused: false,
    peer: undefined,
    prefs,
  })
  gate.setPairingCode({ code: "654321", expiresAt: Date.now() + 60_000 })
  const handle = createGateway({
    options: {
      host: "127.0.0.1",
      port: 0,
      upstream: "http://127.0.0.1:9",
      username: "opencode",
      password: "phone",
      upstreamPassword: "server",
      relayToken: "",
    },
    sync: gate,
  })
  const server = Bun.serve({ port: 0, fetch: (request, srv) => handle(request, srv.requestIP(request)?.address) })
  servers.push(server)
  return { gate, host: `127.0.0.1:${server.port}` }
}

describe("readSyncStart", () => {
  test("defaults to phone access off, unpaused and unpaired", () => {
    expect(readSyncStart(memoryStore().store, "starship")).toEqual({
      machineName: "starship",
      phoneAccess: false,
      paused: false,
      peer: null,
      prefs: null,
    })
  })
})

describe("createMachineSync", () => {
  test("persists phone access and pushes it to the sidecar live", () => {
    const { values, posted, sync } = controller()
    sync.setPhoneAccess(true)
    expect(values.get("phoneAccess")).toBe(true)
    expect(sync.phoneAccess()).toBe(true)
    expect(posted.at(-1)).toEqual({ type: "sync-config", phoneAccess: true, paused: false, peer: null })
  })

  test("creates a six-digit pairing code valid for ten minutes", () => {
    const { posted, sync } = controller()
    expect(sync.createPairingCode()).toEqual({
      code: "123456",
      expiresAt: 601_000,
      machineName: "starship",
      addresses: ["192.168.1.20"],
    })
    expect(posted).toEqual([{ type: "sync-pairing-code", code: "123456", expiresAt: 601_000 }])
  })

  test("pairs with the other machine, stores the peer, then unpairs on both sides", async () => {
    const peer = peerMachine()
    const { values, posted, broadcasts, sync } = controller()
    expect(await sync.pair({ host: peer.host, code: "000000" })).toEqual({ ok: false, reason: "invalid-code" })
    expect(await sync.pair({ host: peer.host, code: "654321" })).toEqual({ ok: true })
    const stored = values.get("syncPeer") as { name: string; url: string; token: string }
    expect(stored.name).toBe("challenger")
    expect(stored.url).toBe(`http://${peer.host}`)
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/)
    expect(peer.gate.peer()?.token).toBe(stored.token)
    expect(posted.at(-1)).toEqual({ type: "sync-config", phoneAccess: false, paused: false, peer: stored })
    expect(broadcasts.findLast((entry) => entry.channel === "machine-sync-status")?.payload).toMatchObject({
      paired: true,
      peerName: "challenger",
    })

    await sync.unpair()
    expect(values.has("syncPeer")).toBe(false)
    expect(posted.at(-1)).toEqual({ type: "sync-config", phoneAccess: false, paused: false, peer: null })
    expect(peer.gate.peer()).toBeUndefined()
  })

  test("pairing with prefs=keep tells windows to restamp and push their own prefs", async () => {
    const peer = peerMachine({ sections: { appearance: { fontSize: 22 } }, updatedAt: 5 })
    const { broadcasts, sync } = controller()
    expect(await sync.pair({ host: peer.host, code: "654321" })).toEqual({ ok: true })
    await sync.idle()
    expect(broadcasts.filter((entry) => entry.channel === "machine-sync-adopt-prefs")).toEqual([
      { channel: "machine-sync-adopt-prefs", payload: null },
    ])
  })

  test("pairing with prefs=theirs hands the peer's prefs to every window", async () => {
    const prefs = { sections: { appearance: { fontSize: 22 } }, updatedAt: 5 }
    const peer = peerMachine(prefs)
    const { broadcasts, sync } = controller()
    expect(await sync.pair({ host: peer.host, code: "654321", prefs: "theirs" })).toEqual({ ok: true })
    await sync.idle()
    expect(broadcasts.filter((entry) => entry.channel === "machine-sync-adopt-prefs")).toEqual([
      { channel: "machine-sync-adopt-prefs", payload: prefs },
    ])
  })

  test("pairing with prefs=theirs falls back to keep when the peer has no prefs", async () => {
    const peer = peerMachine()
    const { broadcasts, sync } = controller()
    expect(await sync.pair({ host: peer.host, code: "654321", prefs: "theirs" })).toEqual({ ok: true })
    await sync.idle()
    expect(broadcasts.filter((entry) => entry.channel === "machine-sync-adopt-prefs")).toEqual([
      { channel: "machine-sync-adopt-prefs", payload: null },
    ])
  })

  test("pairing with prefs=theirs broadcasts no adopt when the peer's prefs cannot be read", async () => {
    const peer = peerMachine({ sections: { appearance: { fontSize: 22 } }, updatedAt: 5 })
    const memory = memoryStore()
    const broadcasts: Array<{ channel: string; payload: unknown }> = []
    const fetchImpl = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        String(input).endsWith("/flynncode-sync/prefs")
          ? Promise.resolve(new Response("boom", { status: 500 }))
          : fetch(input, init),
      { preconnect: fetch.preconnect },
    )
    const sync = createMachineSync({
      store: memory.store,
      machineName: "starship",
      post: () => {},
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      lanAddresses: () => [],
      fetchImpl,
      code: () => "123456",
    })
    expect(await sync.pair({ host: peer.host, code: "654321", prefs: "theirs" })).toEqual({ ok: true })
    await sync.idle()
    expect(memory.values.has("syncPeer")).toBe(true)
    expect(broadcasts.filter((entry) => entry.channel === "machine-sync-adopt-prefs")).toEqual([])
  })

  test("pairing with prefs=theirs broadcasts no adopt when the peer is unreachable for prefs", async () => {
    const peer = peerMachine({ sections: { appearance: { fontSize: 22 } }, updatedAt: 5 })
    const memory = memoryStore()
    const broadcasts: Array<{ channel: string; payload: unknown }> = []
    const fetchImpl = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        String(input).endsWith("/flynncode-sync/prefs") ? Promise.reject(new Error("unreachable")) : fetch(input, init),
      { preconnect: fetch.preconnect },
    )
    const sync = createMachineSync({
      store: memory.store,
      machineName: "starship",
      post: () => {},
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      lanAddresses: () => [],
      fetchImpl,
      code: () => "123456",
    })
    expect(await sync.pair({ host: peer.host, code: "654321", prefs: "theirs" })).toEqual({ ok: true })
    await sync.idle()
    expect(broadcasts.filter((entry) => entry.channel === "machine-sync-adopt-prefs")).toEqual([])
  })

  test("re-pairing tells the previous peer to drop its token", async () => {
    const first = peerMachine()
    const second = peerMachine()
    const { values, sync } = controller()
    expect(await sync.pair({ host: first.host, code: "654321" })).toEqual({ ok: true })
    const firstToken = (values.get("syncPeer") as { token: string }).token
    expect(first.gate.peer()?.token).toBe(firstToken)
    expect(await sync.pair({ host: second.host, code: "654321" })).toEqual({ ok: true })
    await sync.idle()
    expect(first.gate.peer()).toBeUndefined()
    expect(second.gate.peer()?.token).toBe((values.get("syncPeer") as { token: string }).token)
    expect((values.get("syncPeer") as { name: string }).name).toBe("challenger")
  })

  test("applies sidecar messages: paired, unpaired, peer prefs and status", () => {
    const { values, broadcasts, sync } = controller()
    const peer = { name: "challenger", url: "http://192.168.1.10:4097", token: "c".repeat(64) }
    sync.handleSidecarMessage({ type: "sync-paired", peer })
    expect(values.get("syncPeer")).toEqual(peer)
    sync.handleSidecarMessage({
      type: "sync-status",
      status: { ...initialStatus(), phase: "idle", online: true, received: 4 },
    })
    expect(sync.status()).toMatchObject({
      paired: true,
      peerName: "challenger",
      phase: "idle",
      online: true,
      received: 4,
    })
    const prefs = { sections: { appearance: { fontSize: 17 } }, updatedAt: 9 }
    sync.handleSidecarMessage({ type: "sync-peer-prefs", prefs })
    expect(values.get("syncPrefs")).toEqual(prefs)
    expect(broadcasts).toContainEqual({ channel: "machine-sync-peer-prefs", payload: prefs })
    sync.handleSidecarMessage({ type: "sync-unpaired" })
    expect(values.has("syncPeer")).toBe(false)
    expect(sync.status().phase).toBe("unpaired")
  })

  test("resolves Sync now with the matching sidecar status", async () => {
    const { posted, sync } = controller()
    const pending = sync.syncNow()
    const command = posted.at(-1)
    if (command?.type !== "sync-now") throw new Error("expected a sync-now command")
    sync.handleSidecarMessage({
      type: "sync-status",
      status: { ...initialStatus(), phase: "offline" },
      requestID: command.requestID,
    })
    expect((await pending).phase).toBe("unpaired")
  })

  test("answers Sync now at once when the sidecar replies without a worker", async () => {
    const memory = memoryStore()
    const sync: ReturnType<typeof createMachineSync> = createMachineSync({
      store: memory.store,
      machineName: "starship",
      post: (command) => {
        if (command.type === "sync-now")
          sync.handleSidecarMessage({ type: "sync-status", status: initialStatus(), requestID: command.requestID })
      },
      broadcast: () => {},
      lanAddresses: () => [],
    })
    expect((await sync.syncNow()).phase).toBe("unpaired")
  })

  test("hides stale worker fields once unpaired", () => {
    const { sync } = controller()
    sync.handleSidecarMessage({
      type: "sync-status",
      status: { ...initialStatus(), phase: "idle", online: true, received: 4, sent: 2, lastSuccess: 5, lastError: "x" },
    })
    expect(sync.status()).toMatchObject({
      phase: "unpaired",
      online: false,
      received: 0,
      sent: 0,
      lastSuccess: null,
      lastError: null,
    })
  })

  test("keeps newer stored prefs and hands them back to an older window", () => {
    const { values, posted, sync } = controller()
    expect(sync.pushPrefs({ sections: { sounds: {} }, updatedAt: 10 })).toBeUndefined()
    expect(values.get("syncPrefs")).toEqual({ sections: { sounds: {} }, updatedAt: 10 })
    expect(posted.at(-1)).toEqual({ type: "sync-prefs", prefs: { sections: { sounds: {} }, updatedAt: 10 } })
    expect(sync.pushPrefs({ sections: {}, updatedAt: 5 })).toEqual({ sections: { sounds: {} }, updatedAt: 10 })
  })

  test("surfaces a gateway start failure in the status until it clears", () => {
    const { broadcasts, sync } = controller()
    expect(sync.status().gatewayError).toBeNull()
    sync.handleSidecarMessage({ type: "sync-gateway", error: "port 4097 is in use" })
    expect(sync.status().gatewayError).toBe("port 4097 is in use")
    expect(broadcasts.at(-1)?.payload).toMatchObject({ gatewayError: "port 4097 is in use" })
    sync.handleSidecarMessage({ type: "sync-gateway", error: null })
    expect(sync.status().gatewayError).toBeNull()
  })
})

describe("parsePairInput", () => {
  test("accepts a host and a six-digit code, trimmed", () => {
    expect(parsePairInput(" starship.local ", " 123456 ")).toEqual({ host: "starship.local", code: "123456" })
    expect(parsePairInput("192.168.1.20:4097", "000000")).toEqual({ host: "192.168.1.20:4097", code: "000000" })
    expect(parsePairInput("http://192.168.1.20:4097", "123456")?.host).toBe("http://192.168.1.20:4097")
  })

  test("normalizes bracketed IPv6 hosts", () => {
    expect(parsePairInput("[::1]", "123456")?.host).toBe("::1")
    expect(parsePairInput("[fe80::1]:4097", "123456")?.host).toBe("http://[fe80::1]:4097")
    expect(parsePairInput("::1", "123456")?.host).toBe("::1")
  })

  test("rejects non-strings, paths, credentials and malformed codes", () => {
    expect(parsePairInput(undefined, "123456")).toBeUndefined()
    expect(parsePairInput("host", 123456)).toBeUndefined()
    expect(parsePairInput("http://host/path", "123456")).toBeUndefined()
    expect(parsePairInput("user:pw@host", "123456")).toBeUndefined()
    expect(parsePairInput("", "123456")).toBeUndefined()
    expect(parsePairInput("host", "12345")).toBeUndefined()
    expect(parsePairInput("host", "12345a")).toBeUndefined()
  })
})
