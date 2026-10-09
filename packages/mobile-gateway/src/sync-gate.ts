import { randomBytes, timingSafeEqual } from "node:crypto"
import { createNonceCache, signResponse, verifyRequest } from "./sync-sign.ts"

export type SyncPeer = { name: string; url: string; token: string }
export type SyncPrefs = { sections: Record<string, unknown>; updatedAt: number }
export type PairingCode = { code: string; expiresAt: number }

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000
export const MAX_PAIR_ATTEMPTS = 5
const MAX_NAME_LENGTH = 64
// Tokens are minted as 32 random bytes in hex; anything else stored (an empty
// or hand-edited record) must never verify a request.
const TOKEN = /^[0-9a-f]{64}$/

export type SyncGate = ReturnType<typeof createSyncGate>

// Live sync state shared by the gateway routes and the sync worker. The
// desktop sidecar owns one gate and updates it from main-process messages, so
// phone access, pairing and pause apply without restarting anything.
export function createSyncGate(input: {
  machineName: string
  gatewayPort: number
  phoneAccess: boolean
  paused: boolean
  peer: SyncPeer | undefined
  prefs: SyncPrefs | undefined
  now?: () => number
  token?: () => string
  onPaired?: (peer: SyncPeer) => void
  onUnpaired?: () => void
  /** The paired machine now answers at a new address; persist it. */
  onPeerMoved?: (peer: SyncPeer) => void
}) {
  const now = input.now ?? Date.now
  const makeToken = input.token ?? (() => randomBytes(32).toString("hex"))
  const state = {
    phoneAccess: input.phoneAccess,
    paused: input.paused,
    peer: input.peer,
    prefs: input.prefs,
    pairing: undefined as PairingCode | undefined,
    attempts: 0,
    sent: 0,
  }
  const nonces = createNonceCache({ now })

  // The peer's stored address follows the socket address of verified
  // requests, so a DHCP change is picked up instead of polling a stale
  // address (possibly another device) forever. A stored host name already
  // follows the peer through DNS and is kept, as is the stored port.
  const follow = (token: string, remoteAddress: string | undefined) => {
    const peer = state.peer
    const host = remoteAddress === undefined ? undefined : urlHost(remoteAddress)
    if (!peer || peer.token !== token || !host) return
    const current = new URL(peer.url)
    if (!isAddress(current.hostname) || current.hostname === host) return
    current.hostname = host
    const moved = { ...peer, url: current.origin }
    state.peer = moved
    input.onPeerMoved?.(moved)
  }

  return {
    phoneAccess: () => state.phoneAccess,
    paused: () => state.paused,
    peer: () => state.peer,
    prefs: () => state.prefs,
    pairingActive: () => state.pairing !== undefined && state.pairing.expiresAt > now(),
    /**
     * Checks a request's signature, time and nonce (each nonce is accepted
     * once). Only a verified request gets a response signer and may move the
     * peer's stored address.
     */
    verify(request: { method: string; target: string; headers: Headers; body: Uint8Array }) {
      const peer = state.peer
      if (!peer || !TOKEN.test(peer.token)) return
      const nonce = verifyRequest({ token: peer.token, ...request, now: now() })
      if (!nonce || !nonces.claim(nonce)) return
      const token = peer.token
      return {
        sign: (body: Uint8Array) => signResponse(token, nonce, body),
        seen: (remoteAddress: string | undefined) => follow(token, remoteAddress),
      }
    },
    update(next: { phoneAccess?: boolean; paused?: boolean; peer?: SyncPeer | null; prefs?: SyncPrefs }) {
      state.phoneAccess = next.phoneAccess ?? state.phoneAccess
      state.paused = next.paused ?? state.paused
      state.peer = next.peer === null ? undefined : (next.peer ?? state.peer)
      state.prefs = next.prefs ?? state.prefs
    },
    setPairingCode(code: PairingCode | undefined) {
      state.pairing = code
      state.attempts = 0
    },
    pair(request: {
      code: string
      name: string
      remoteAddress: string | undefined
      /** What the caller says it can be reached at: its host name and LAN addresses. */
      advertised?: { host?: string; addresses?: string[] }
    }) {
      const pairing = state.pairing
      if (!pairing || pairing.expiresAt <= now()) return "invalid" as const
      const host = peerHost(request.remoteAddress, request.advertised)
      if (!host) return "unaddressable" as const
      if (!safeEqual(request.code.trim(), pairing.code)) {
        state.attempts += 1
        if (state.attempts < MAX_PAIR_ATTEMPTS) return "invalid" as const
        // A six-digit code must not survive guessing over the LAN.
        state.pairing = undefined
        return "locked" as const
      }
      const peer = {
        name: request.name.trim().slice(0, MAX_NAME_LENGTH) || "peer",
        url: `http://${host}:${input.gatewayPort}`,
        token: makeToken(),
      }
      state.pairing = undefined
      state.attempts = 0
      state.peer = peer
      input.onPaired?.(peer)
      return { token: peer.token, name: input.machineName }
    },
    revoke() {
      state.peer = undefined
      input.onUnpaired?.()
    },
    countSent() {
      state.sent += 1
    },
    takeSent() {
      const sent = state.sent
      state.sent = 0
      return sent
    },
  }
}

// The paired machine runs its gateway on the same port, so its URL is the
// caller's address plus our own gateway port. A link-local IPv6 caller is only
// reachable through its zone, which a URL cannot carry, so the address it
// advertised is used instead. Without a usable address pairing is refused.
function peerHost(remoteAddress: string | undefined, advertised: { host?: string; addresses?: string[] } | undefined) {
  if (remoteAddress === undefined) return
  return urlHost(remoteAddress) ?? advertised?.addresses?.find(isAddress) ?? advertised?.host
}

// The URL host for a socket address: IPv4-mapped addresses lose their prefix,
// IPv6 gets brackets, and link-local or zoned IPv6 has no usable URL form.
function urlHost(remoteAddress: string) {
  const address = remoteAddress.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "")
  if (!address.includes(":")) return address
  if (address.includes("%") || /^fe[89ab]/i.test(address)) return
  return `[${address}]`
}

// An IP literal as it appears in a URL host (IPv6 in brackets), not a name.
function isAddress(host: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:.]+\]$/i.test(host)
}

function safeEqual(got: string, want: string) {
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
