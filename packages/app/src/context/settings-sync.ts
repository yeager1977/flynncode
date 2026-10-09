import type { MachineSyncPlatform, MachineSyncPrefs } from "./machine-sync-types"
import type { Settings } from "./settings"

export const SYNCED_SECTIONS = ["general", "appearance", "keybinds", "notifications", "sounds"] as const
export type SyncedSection = (typeof SYNCED_SECTIONS)[number]

// These `general` fields record this install's upgrade history, not a
// preference, so they never travel between machines.
export const LOCAL_GENERAL_KEYS = [
  "newLayoutDesigns",
  "layoutTransitionEligible",
  "agentVisibilityInitialized",
  "newInterfaceNoticeDismissed",
  "shouldDisplayTabsToast",
] as const

export function syncableSections(settings: Settings): Record<string, unknown> {
  return Object.fromEntries(
    SYNCED_SECTIONS.flatMap((section) => {
      const value: unknown = settings[section]
      return isRecord(value) ? [[section, shared(section, value)] as const] : []
    }),
  )
}

export function syncKey(sections: Record<string, unknown>) {
  return stableStringify(sections)
}

export function mergePeerSections(current: Settings, peer: MachineSyncPrefs): Partial<Pick<Settings, SyncedSection>> {
  const local: unknown = current.general
  const kept = isRecord(local)
    ? Object.fromEntries(Object.entries(local).filter(([key]) => isLocalGeneralKey(key)))
    : {}
  const entries = SYNCED_SECTIONS.flatMap((section) => {
    const incoming = peer.sections[section]
    if (!isRecord(incoming)) return []
    return [[section, section === "general" ? { ...shared(section, incoming), ...kept } : incoming] as const]
  })
  // Peer prefs come from the same Flynncode version (the worker stops on a
  // version mismatch before it pulls prefs), so section shapes match ours.
  return Object.fromEntries(entries) as Partial<Pick<Settings, SyncedSection>>
}

// Drops the launch-state flags from `general`; other sections pass through.
function shared(section: SyncedSection, value: Record<string, unknown>) {
  if (section !== "general") return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isLocalGeneralKey(key)))
}

// Decides when synced preferences are stamped, pushed to the desktop and
// replaced from the peer. The caller owns the reactive store: `read` must read
// through it (so `check` can run in an effect) and `write` must apply sections
// and the stamp together.
export function createSettingsSync(input: {
  platform: Pick<MachineSyncPlatform, "pushPrefs">
  ready: () => boolean
  read: () => Settings
  write: (sections: Partial<Pick<Settings, SyncedSection>>, updatedAt: number) => void
  now?: () => number
  onError?: (error: unknown) => void
}) {
  const now = input.now ?? Date.now
  const onError =
    input.onError ?? ((error: unknown) => console.warn("[machine-sync] could not push preferences", error))
  const state = { previous: undefined as string | undefined }

  const push = (sections: Record<string, unknown>, updatedAt: number) => {
    // The sections still hold live store proxies (so `check` tracks them), and
    // a Proxy cannot cross IPC's structured clone: send plain JSON data.
    const plain: Record<string, unknown> = JSON.parse(JSON.stringify(sections))
    void input.platform.pushPrefs({ sections: plain, updatedAt }).then((newer) => {
      if (newer) applyPeer(newer)
    }, onError)
  }

  // Replaces the synced sections with the peer's. The snapshot is recorded
  // first so `check` sees no local edit and does not push them straight back.
  const replace = (prefs: MachineSyncPrefs, updatedAt: number) => {
    const merged = mergePeerSections(input.read(), prefs)
    state.previous = syncKey(syncableSections({ ...input.read(), ...merged }))
    input.write(merged, updatedAt)
  }

  const applyPeer = (prefs: MachineSyncPrefs) => {
    // Before hydration the store holds defaults; the first push after ready
    // gets the newer stored prefs back from the desktop instead.
    if (!input.ready()) return
    if (prefs.updatedAt <= (input.read().syncUpdatedAt ?? 0)) return
    replace(prefs, prefs.updatedAt)
  }

  return {
    applyPeer,
    // Run from an effect: the first snapshot goes out with the stored stamp,
    // every later change to a synced section is stamped now and pushed.
    check() {
      if (!input.ready()) return
      const sections = syncableSections(input.read())
      const key = syncKey(sections)
      if (key === state.previous) return
      const first = state.previous === undefined
      state.previous = key
      const updatedAt = first ? (input.read().syncUpdatedAt ?? 0) : now()
      if (!first) input.write({}, updatedAt)
      push(sections, updatedAt)
    },
    // After pairing: null keeps this computer's prefs (restamped so they
    // become newest); otherwise the peer's prefs are adopted, also restamped,
    // so the choice propagates instead of losing to an older/newer stamp.
    adopt(prefs: MachineSyncPrefs | null) {
      if (!input.ready()) return
      const updatedAt = now()
      if (prefs) replace(prefs, updatedAt)
      else input.write({}, updatedAt)
      const sections = syncableSections(input.read())
      state.previous = syncKey(sections)
      push(sections, updatedAt)
    },
  }
}

function isLocalGeneralKey(key: string) {
  return (LOCAL_GENERAL_KEYS as readonly string[]).includes(key)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
