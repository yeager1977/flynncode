import { describe, expect, test } from "bun:test"
import {
  createNonceCache,
  SIGNATURE_WINDOW_MS,
  signRequest,
  signResponse,
  verifyRequest,
  verifyResponse,
} from "../src/sync-sign.ts"

describe("nonce cache", () => {
  test("accepts a nonce once and forgets it after twice the signature window", () => {
    const clock = { now: 0 }
    const cache = createNonceCache({ now: () => clock.now })
    expect(cache.claim("a")).toBe(true)
    expect(cache.claim("a")).toBe(false)
    clock.now = 2 * SIGNATURE_WINDOW_MS - 1
    expect(cache.claim("a")).toBe(false)
    clock.now = 2 * SIGNATURE_WINDOW_MS
    expect(cache.claim("a")).toBe(true)
  })

  test("refuses new nonces while full instead of growing", () => {
    const clock = { now: 0 }
    const cache = createNonceCache({ now: () => clock.now, limit: 2 })
    expect(cache.claim("a")).toBe(true)
    expect(cache.claim("b")).toBe(true)
    expect(cache.claim("c")).toBe(false)
    clock.now = 2 * SIGNATURE_WINDOW_MS
    expect(cache.claim("c")).toBe(true)
  })
})

describe("request signatures", () => {
  test("cover the body as well as the method, path and time", () => {
    const token = "a".repeat(64)
    const signed = signRequest({ token, method: "POST", target: "/flynncode-sync/unpair", body: "", now: 1_000 })
    const verify = (body: string) =>
      verifyRequest({
        token,
        method: "POST",
        target: "/flynncode-sync/unpair",
        headers: new Headers(signed.headers),
        body: new TextEncoder().encode(body),
        now: 1_000,
      })
    expect(verify("")).toEqual({ nonce: signed.nonce, fresh: true })
    expect(verify("x")).toBeUndefined()
    expect(signed.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(signed.headers)).not.toContain(token)
  })
})

describe("response signatures", () => {
  test("cover the status as well as the nonce and body", () => {
    const token = "a".repeat(64)
    const body = new TextEncoder().encode("{}")
    const signature = signResponse(token, "3".repeat(32), 200, body)
    expect(verifyResponse(token, "3".repeat(32), 200, body, signature)).toBe(true)
    expect(verifyResponse(token, "3".repeat(32), 503, body, signature)).toBe(false)
    expect(verifyResponse(token, "4".repeat(32), 200, body, signature)).toBe(false)
  })
})
