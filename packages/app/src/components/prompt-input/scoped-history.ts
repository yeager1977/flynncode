import { createRoot, getOwner, onCleanup, type Owner } from "solid-js"
import { createPersistedPromptInputHistory, type PromptInputHistory } from "./history-store"

const MAX_SESSION_HISTORIES = 8

export type ScopedHistoryDeps = {
  createGlobal: () => PromptInputHistory
  createPersisted: (input: { directory: string; sessionID: string }) => PromptInputHistory
}

export function createScopedHistoryRouter(input: {
  sessionID: () => string | undefined
  global: PromptInputHistory
  create: (input: { sessionID: string }) => PromptInputHistory
  dispose?: (sessionID: string, history: PromptInputHistory) => void
  max?: number
}): PromptInputHistory {
  const cache = new Map<string, PromptInputHistory>()
  const max = input.max ?? MAX_SESSION_HISTORIES

  const prune = () => {
    while (cache.size > max) {
      const first = cache.keys().next().value
      if (!first) return
      const evicted = cache.get(first)
      cache.delete(first)
      if (evicted) input.dispose?.(first, evicted)
    }
  }

  const load = (id: string) => {
    const existing = cache.get(id)
    if (existing) {
      cache.delete(id)
      cache.set(id, existing)
      return existing
    }
    const entry = input.create({ sessionID: id })
    cache.set(id, entry)
    prune()
    return entry
  }

  return {
    entries: (mode) => {
      const id = input.sessionID()
      if (!id) return input.global.entries(mode)
      return load(id).entries(mode)
    },
    add(prompt, mode, comments) {
      const id = input.sessionID()
      if (!id) return input.global.add(prompt, mode, comments)
      load(id).add(prompt, mode, comments)
    },
  }
}

export function createScopedPromptInputHistory(
  sessionID: () => string | undefined,
  directory: () => string,
  deps: ScopedHistoryDeps,
): PromptInputHistory {
  const owner: Owner | undefined = getOwner() ?? undefined
  const roots = new Map<string, () => void>()
  if (owner) onCleanup(() => roots.forEach((dispose) => dispose()))

  return createScopedHistoryRouter({
    sessionID,
    global: deps.createGlobal(),
    create: ({ sessionID }) => {
      const make = () => deps.createPersisted({ directory: directory(), sessionID })
      if (!owner) return make()
      // A createRoot callback without parameters gets Solid's shared unowned root, which has no context.
      // Roots are not disposed with their owner either, so eviction and the owner's cleanup dispose them.
      return createRoot((dispose) => {
        roots.set(sessionID, dispose)
        return make()
      }, owner)
    },
    dispose: (sessionID) => {
      roots.get(sessionID)?.()
      roots.delete(sessionID)
    },
  })
}