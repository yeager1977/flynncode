import { describe, expect, test } from "bun:test"
import { decide, decidePush, type Manifest, type ManifestSession } from "../src/sync-decide.ts"
import { SYNC_NONCE_HEADER, SYNC_RESPONSE_SIGNATURE_HEADER, signResponse } from "../src/sync-sign.ts"
import { createSyncWorker } from "../src/sync-worker.ts"

const TOKEN = "00".repeat(32)

const session = (id: string, timeUpdated: number, extra: Partial<ManifestSession> = {}): ManifestSession => ({
  id,
  parentID: null,
  timeUpdated,
  timeArchived: null,
  busy: false,
  ...extra,
})

const emptyManifest = (): Manifest => ({ schema: "s1", app: "a1", sessions: [], tombstones: [] })

const bundle = (id: string, timeUpdated: number) => ({ session: { id, time_updated: timeUpdated } })

type Store = { manifest: Manifest; bundles: Map<string, unknown>; applied: string[] }

function store(sessions: ManifestSession[]): Store {
  return {
    manifest: { schema: "s1", app: "a1", sessions: [...sessions], tombstones: [] },
    bundles: new Map(sessions.map((item) => [item.id, bundle(item.id, item.timeUpdated)])),
    applied: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function upsert(target: Store, id: string, timeUpdated: number) {
  target.bundles.set(id, bundle(id, timeUpdated))
  const current = target.manifest.sessions.find((item) => item.id === id)
  if (current) current.timeUpdated = timeUpdated
  else target.manifest.sessions.push(session(id, timeUpdated))
}

function nonceOf(init?: RequestInit): string | null {
  const headers: unknown = init?.headers
  if (!headers) return null
  if (headers instanceof Headers) return headers.get(SYNC_NONCE_HEADER)
  if (typeof headers === "object") {
    const record = headers as Record<string, string>
    return record[SYNC_NONCE_HEADER] ?? record[SYNC_NONCE_HEADER.toLowerCase()] ?? null
  }
  return null
}

function signed(payload: unknown, status: number, nonce: string | null): Response {
  const text = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(text)
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (nonce) headers[SYNC_RESPONSE_SIGNATURE_HEADER] = signResponse(TOKEN, nonce, status, bytes)
  return new Response(bytes, { status, headers })
}

function bundleOf(body: unknown): { id: string; timeUpdated: number } | undefined {
  if (!isRecord(body)) return undefined
  const wrap = body.bundle
  if (!isRecord(wrap)) return undefined
  const inner = wrap.session
  if (!isRecord(inner)) return undefined
  if (typeof inner.id !== "string" || typeof inner.time_updated !== "number") return undefined
  return { id: inner.id, timeUpdated: inner.time_updated }
}

function world() {
  const hub = store([])
  const spokeA = store([session("c1", 200)])
  const spokeB = store([])
  const state = { hubDown: false, hubApplies: 0 }

  const localAnswer = (target: Store, pathname: string, parsed: unknown): Response => {
    if (pathname === "/flynncode-sync/manifest") return Response.json(target.manifest)
    const match = /^\/flynncode-sync\/session\/(.+)$/.exec(pathname)
    if (match) {
      const found = target.bundles.get(decodeURIComponent(match[1] ?? ""))
      return found ? Response.json(found) : Response.json({ error: "not found" }, { status: 404 })
    }
    if (pathname === "/flynncode-sync/apply") {
      const incoming = bundleOf(parsed)
      if (!incoming) return Response.json({ error: "bad bundle" }, { status: 400 })
      upsert(target, incoming.id, incoming.timeUpdated)
      target.applied.push(incoming.id)
      return Response.json({ ok: true })
    }
    if (pathname === "/flynncode-sync/missing") return Response.json({ directories: [] })
    if (pathname === "/flynncode-sync/reload") return Response.json({ pending: null, busy: false })
    if (pathname === "/flynncode-sync/settings") return Response.json({ config: null, mtime: 0 })
    if (pathname === "/flynncode-sync/prefs") return Response.json({ prefs: null })
    return Response.json({ error: "not found" }, { status: 404 })
  }

  const hubAnswer = (pathname: string, parsed: unknown, nonce: string | null): Response => {
    if (state.hubDown) return signed({ error: "down" }, 503, nonce)
    if (pathname === "/flynncode-sync/manifest") return signed(hub.manifest, 200, nonce)
    const match = /^\/flynncode-sync\/session\/(.+)$/.exec(pathname)
    if (match) {
      const id = decodeURIComponent(match[1] ?? "")
      if (hub.manifest.sessions.some((item) => item.id === id && item.busy))
        return signed({ error: "busy" }, 409, nonce)
      const found = hub.bundles.get(id)
      return found ? signed(found, 200, nonce) : signed({ error: "not found" }, 404, nonce)
    }
    if (pathname === "/flynncode-sync/apply") {
      const incoming = bundleOf(parsed)
      if (!incoming) return signed({ error: "bad bundle" }, 400, nonce)
      if (hub.manifest.sessions.some((item) => item.id === incoming.id && item.busy))
        return signed({ error: "busy" }, 409, nonce)
      upsert(hub, incoming.id, incoming.timeUpdated)
      state.hubApplies += 1
      return signed({ ok: true }, 200, nonce)
    }
    if (pathname === "/flynncode-sync/settings") return signed({ config: null, mtime: 0 }, 200, nonce)
    if (pathname === "/flynncode-sync/prefs") return signed({ prefs: null }, 200, nonce)
    return signed({ error: "not found" }, 404, nonce)
  }

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = String(url)
    const pathname = new URL(target).pathname
    let parsed: unknown = undefined
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = undefined
      }
    }
    if (target.startsWith("http://a/")) return localAnswer(spokeA, pathname, parsed)
    if (target.startsWith("http://b/")) return localAnswer(spokeB, pathname, parsed)
    return hubAnswer(pathname, parsed, nonceOf(init))
  }

  const makeWorker = (localUrl: string) =>
    createSyncWorker({
      local: { url: localUrl, authorization: "Bearer x" },
      peer: () => ({ name: "hub", url: "http://hub", token: TOKEN }),
      paused: () => false,
      prefs: { get: () => undefined, apply: () => undefined },
      takeSent: () => 0,
      onStatus: () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
    })

  return { hub, spokeA, spokeB, state, workerA: makeWorker("http://a"), workerB: makeWorker("http://b") }
}

describe("hub-spoke e2e", () => {
  test("spoke A pushes c1 to the hub and spoke B pulls it", async () => {
    const env = world()
    expect(decidePush({ local: env.spokeA.manifest, hub: env.hub.manifest })).toEqual([{ type: "push", id: "c1" }])

    const pushed = await env.workerA.cycle()
    expect(pushed.phase).toBe("idle")
    expect(env.state.hubApplies).toBe(1)
    expect(env.hub.manifest.sessions).toMatchObject([{ id: "c1", timeUpdated: 200 }])

    expect(decide({ local: env.spokeB.manifest, peer: env.hub.manifest })).toEqual([{ type: "pull", id: "c1" }])
    const pulled = await env.workerB.cycle()
    expect(pulled.phase).toBe("idle")
    expect(env.spokeB.applied).toEqual(["c1"])
    expect(env.spokeB.manifest.sessions).toMatchObject([{ id: "c1", timeUpdated: 200 }])
  })

  test("a hub-newer copy flows back to spoke A", async () => {
    const env = world()
    await env.workerA.cycle()
    await env.workerB.cycle()
    expect(env.spokeB.manifest.sessions).toMatchObject([{ id: "c1", timeUpdated: 200 }])

    upsert(env.spokeB, "c1", 300)
    const pushed = await env.workerB.cycle()
    expect(pushed.phase).toBe("idle")
    expect(env.hub.manifest.sessions).toMatchObject([{ id: "c1", timeUpdated: 300 }])

    expect(decide({ local: env.spokeA.manifest, peer: env.hub.manifest })).toEqual([{ type: "pull", id: "c1" }])
    const pulled = await env.workerA.cycle()
    expect(pulled.phase).toBe("idle")
    expect(env.spokeA.applied).toEqual(["c1"])
    expect(env.spokeA.manifest.sessions).toMatchObject([{ id: "c1", timeUpdated: 300 }])
  })

  test("a busy hub is skipped instead of overwritten", async () => {
    const env = world()
    await env.workerA.cycle()
    await env.workerB.cycle()

    upsert(env.spokeA, "c1", 400)
    const busy = env.hub.manifest.sessions.find((item) => item.id === "c1")
    if (busy) busy.busy = true
    expect(decidePush({ local: env.spokeA.manifest, hub: env.hub.manifest })).toEqual([
      { type: "skip", id: "c1", reason: "peer-busy" },
    ])

    const status = await env.workerA.cycle()
    expect(status.phase).toBe("idle")
    expect(status.skipped).toContainEqual({ id: "c1", reason: "peer-busy" })
    expect(env.state.hubApplies).toBe(1)
    expect(env.hub.manifest.sessions).toMatchObject([{ id: "c1", timeUpdated: 200 }])
  })

  test("an offline hub queues the push until it is back", async () => {
    const env = world()
    env.state.hubDown = true
    const offline = await env.workerA.cycle()
    expect(offline.phase).toBe("offline")
    expect(env.state.hubApplies).toBe(0)

    env.state.hubDown = false
    const recovered = await env.workerA.cycle()
    expect(recovered.phase).toBe("idle")
    expect(env.hub.manifest.sessions).toMatchObject([{ id: "c1", timeUpdated: 200 }])
    const pulled = await env.workerB.cycle()
    expect(env.spokeB.applied).toEqual(["c1"])
    expect(pulled.phase).toBe("idle")
  })
})
