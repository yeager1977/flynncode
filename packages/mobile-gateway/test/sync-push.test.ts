import { expect, test } from "bun:test"
import { SYNC_NONCE_HEADER, SYNC_RESPONSE_SIGNATURE_HEADER, signResponse } from "../src/sync-sign.ts"
import { createSyncWorker } from "../src/sync-worker.ts"

const TOKEN = "00".repeat(32)

test("push sends local-newer bundle to hub apply", async () => {
  const calls: string[] = []
  const bodies: Array<{ method: string; target: string; body: unknown }> = []
  const nonceOf = (init?: RequestInit): string | null => {
    const headers: unknown = init?.headers
    if (!headers) return null
    if (headers instanceof Headers) return headers.get(SYNC_NONCE_HEADER)
    if (typeof headers === "object") {
      const record = headers as Record<string, string>
      return record[SYNC_NONCE_HEADER] ?? record[SYNC_NONCE_HEADER.toLowerCase()] ?? null
    }
    return null
  }
  const signed = (payload: unknown, status: number, nonce: string | null): Response => {
    const text = JSON.stringify(payload)
    const bytes = new TextEncoder().encode(text)
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (nonce) headers[SYNC_RESPONSE_SIGNATURE_HEADER] = signResponse(TOKEN, nonce, status, bytes)
    return new Response(bytes, { status, headers })
  }
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = String(url)
    const method = init?.method ?? "GET"
    calls.push(`${method} ${target}`)
    let parsed: unknown = undefined
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = undefined
      }
    }
    bodies.push({ method, target, body: parsed })
    if (target.startsWith("http://local")) {
      if (target.endsWith("/flynncode-sync/manifest")) {
        return Response.json({ schema: "s1", app: "a1", sessions: [{ id: "c1", parentID: null, timeUpdated: 200, timeArchived: null, busy: false }], tombstones: [] })
      }
      if (target.endsWith("/flynncode-sync/session/c1")) {
        return Response.json({ version: 1, session: { id: "c1" } })
      }
      if (target.endsWith("/flynncode-sync/missing")) return Response.json({ directories: [] })
      if (target.endsWith("/flynncode-sync/reload")) return Response.json({ pending: null, busy: false })
      if (target.endsWith("/flynncode-sync/settings")) return Response.json({ config: null, mtime: 0 })
      if (target.endsWith("/flynncode-sync/prefs")) return Response.json({ prefs: null })
      return Response.json({ error: "not found" }, { status: 404 })
    }
    const nonce = nonceOf(init)
    if (target.endsWith("/flynncode-sync/manifest")) {
      return signed({ schema: "s1", app: "a1", sessions: [{ id: "c1", parentID: null, timeUpdated: 100, timeArchived: null, busy: false }], tombstones: [] }, 200, nonce)
    }
    if (target.endsWith("/flynncode-sync/session/c1")) {
      return signed({ version: 1, session: { id: "c1" } }, 200, nonce)
    }
    if (target.endsWith("/flynncode-sync/apply")) return signed({ ok: true }, 200, nonce)
    if (target.endsWith("/flynncode-sync/missing")) return signed({ directories: [] }, 200, nonce)
    if (target.endsWith("/flynncode-sync/reload")) return signed({ pending: null, busy: false }, 200, nonce)
    if (target.endsWith("/flynncode-sync/settings")) return signed({ config: null, mtime: 0 }, 200, nonce)
    if (target.endsWith("/flynncode-sync/prefs")) return signed({ prefs: null }, 200, nonce)
    return signed({ error: "not found" }, 404, nonce)
  }
  const worker = createSyncWorker({
    local: { url: "http://local", authorization: "Bearer x" },
    peer: () => ({ name: "hub", url: "http://hub:4097", token: "00".repeat(32) }),
    paused: () => false,
    prefs: { get: () => undefined, apply: () => undefined },
    takeSent: () => 0,
    onStatus: () => undefined,
    fetchImpl: fetchImpl as typeof fetch,
  })
  const status = await worker.cycle()
  expect(status.phase).toBe("idle")
  expect(calls.some((call) => call === "POST http://hub:4097/flynncode-sync/apply")).toBe(true)
  const posted = bodies.find((item) => item.method === "POST" && item.target === "http://hub:4097/flynncode-sync/apply")
  expect(posted?.body).toMatchObject({ expected: { timeUpdated: 100, timeArchived: null } })
})
