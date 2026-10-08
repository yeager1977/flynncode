export type RelayDigest = {
  originID: string
  items: Array<{ sessionID: string; directory: string | undefined; title: string; kind: "permission" | "question"; updated: number }>
  updatedAt: number
}

const RELAY_TTL_MS = 24 * 3600 * 1000

export function createRelayStore(input?: { now?: () => number }) {
  const now = input?.now ?? Date.now
  const digests = new Map<string, RelayDigest>()
  return {
    publish(digest: RelayDigest) {
      if (!digest.originID) return
      digests.set(digest.originID, digest)
    },
    list(): RelayDigest[] {
      const cutoff = now() - RELAY_TTL_MS
      return [...digests.values()].filter((digest) => digest.updatedAt >= cutoff)
    },
  }
}

export function isRelayAuthorized(header: string | null, expected: string) {
  if (!expected) return false
  return header === `Bearer ${expected}`
}
