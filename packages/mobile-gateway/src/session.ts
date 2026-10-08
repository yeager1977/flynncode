import { MAX_AGE_SECONDS } from "./cookies.ts"

export type SessionStore = {
  issue(): string
  verify(token: string | undefined): boolean
  size(): number
}

// A session token lives exactly as long as the cookie that carries it.
const SESSION_TTL_MS = MAX_AGE_SECONDS * 1000

function defaultToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function createSessionStore(input?: { token?: () => string; now?: () => number }): SessionStore {
  const issuedAt = new Map<string, number>()
  const makeToken = input?.token ?? defaultToken
  const now = input?.now ?? Date.now

  function prune() {
    const cutoff = now() - SESSION_TTL_MS
    for (const [token, issued] of issuedAt) {
      if (issued <= cutoff) issuedAt.delete(token)
    }
  }

  return {
    issue() {
      prune()
      const token = makeToken()
      issuedAt.set(token, now())
      return token
    },
    verify(token) {
      prune()
      if (!token) return false
      return issuedAt.has(token)
    },
    size() {
      return issuedAt.size
    },
  }
}
