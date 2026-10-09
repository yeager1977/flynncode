import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

// After pairing the token never crosses the network: each request carries an
// HMAC-SHA256 over its method, path and query, time, a fresh nonce and the
// body hash, and each answer to a verified request carries an HMAC over that
// nonce and the response body, so an on-path attacker can neither replay a
// request nor alter what the peer sends back.
export const SYNC_TIME_HEADER = "x-flynncode-sync-time"
export const SYNC_NONCE_HEADER = "x-flynncode-sync-nonce"
export const SYNC_SIGNATURE_HEADER = "x-flynncode-sync-signature"
export const SYNC_RESPONSE_SIGNATURE_HEADER = "x-flynncode-sync-response-signature"
/** A request older or newer than this (by the receiver's clock) is refused. */
export const SIGNATURE_WINDOW_MS = 60_000

const NONCE = /^[0-9a-f]{32}$/
const SIGNATURE = /^[0-9a-f]{64}$/
const TIME = /^\d{1,16}$/
const NONCE_CACHE_LIMIT = 10_000

export type SignedReply = { status: number; body: Uint8Array<ArrayBuffer>; verified: boolean }

export function signRequest(input: {
  token: string
  method: string
  target: string
  body?: Uint8Array | string
  now?: number
  nonce?: string
}) {
  const time = String(input.now ?? Date.now())
  const nonce = input.nonce ?? randomBytes(16).toString("hex")
  const signature = hmac(input.token, requestMessage({ ...input, time, nonce }))
  return {
    nonce,
    headers: { [SYNC_TIME_HEADER]: time, [SYNC_NONCE_HEADER]: nonce, [SYNC_SIGNATURE_HEADER]: signature },
  }
}

/** The request's nonce when its signature and time check out, otherwise undefined. */
export function verifyRequest(input: {
  token: string
  method: string
  target: string
  headers: Headers
  body: Uint8Array
  now: number
}) {
  const time = input.headers.get(SYNC_TIME_HEADER)
  const nonce = input.headers.get(SYNC_NONCE_HEADER)
  const signature = input.headers.get(SYNC_SIGNATURE_HEADER)
  if (!time || !TIME.test(time) || !nonce || !NONCE.test(nonce) || !signature) return
  if (Math.abs(input.now - Number(time)) > SIGNATURE_WINDOW_MS) return
  if (!sameSignature(signature, hmac(input.token, requestMessage({ ...input, time, nonce })))) return
  return nonce
}

export function signResponse(token: string, nonce: string, body: Uint8Array | string) {
  return hmac(token, `${nonce}\n${bodyHash(body)}`)
}

export function verifyResponse(token: string, nonce: string, body: Uint8Array, signature: string | null) {
  return signature !== null && sameSignature(signature, signResponse(token, nonce, body))
}

/**
 * Remembers nonces for twice the signature window (a request is accepted for
 * up to one window either side of its time), so a captured request cannot be
 * replayed. Full means refuse: the cache never grows past its limit.
 */
export function createNonceCache(input: { now?: () => number; limit?: number } = {}) {
  const now = input.now ?? Date.now
  const limit = input.limit ?? NONCE_CACHE_LIMIT
  const seen = new Map<string, number>()
  return {
    claim(nonce: string) {
      const at = now()
      // Entries go in with increasing expiry, so the expired ones are at the front.
      for (const [key, expires] of seen) {
        if (expires > at) break
        seen.delete(key)
      }
      if (seen.has(nonce) || seen.size >= limit) return false
      seen.set(nonce, at + 2 * SIGNATURE_WINDOW_MS)
      return true
    },
  }
}

/**
 * Sends a signed request to the paired machine and checks the signature of
 * its answer. Resolves undefined when there is no answer at all.
 */
export async function signedRequest(input: {
  peer: { url: string; token: string }
  path: string
  method?: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}): Promise<SignedReply | undefined> {
  const method = input.method ?? "GET"
  const signed = signRequest({ token: input.peer.token, method, target: input.path })
  const response = await (input.fetchImpl ?? fetch)(`${input.peer.url}${input.path}`, {
    method,
    headers: signed.headers,
    redirect: "error",
    signal: AbortSignal.timeout(input.timeoutMs),
  }).catch(() => undefined)
  if (!response) return
  const body = await response.arrayBuffer().then(
    (buffer) => new Uint8Array(buffer),
    () => undefined,
  )
  if (!body) return
  const signature = response.headers.get(SYNC_RESPONSE_SIGNATURE_HEADER)
  return {
    status: response.status,
    body,
    verified: verifyResponse(input.peer.token, signed.nonce, body, signature),
  }
}

export function bodyHash(body: Uint8Array | string = "") {
  return createHash("sha256").update(body).digest("hex")
}

function requestMessage(input: {
  method: string
  target: string
  time: string
  nonce: string
  body?: Uint8Array | string
}) {
  return [input.method.toUpperCase(), input.target, input.time, input.nonce, bodyHash(input.body)].join("\n")
}

function hmac(token: string, message: string) {
  return createHmac("sha256", token).update(message).digest("hex")
}

function sameSignature(got: string, want: string) {
  if (!SIGNATURE.test(got)) return false
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"))
}
