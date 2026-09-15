export type SessionStore = {
  issue(): string
  verify(token: string | undefined): boolean
  size(): number
}

function defaultToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function createSessionStore(input?: { token?: () => string }): SessionStore {
  const tokens = new Set<string>()
  const makeToken = input?.token ?? defaultToken

  return {
    issue() {
      const token = makeToken()
      tokens.add(token)
      return token
    },
    verify(token) {
      if (!token) return false
      return tokens.has(token)
    },
    size() {
      return tokens.size
    },
  }
}