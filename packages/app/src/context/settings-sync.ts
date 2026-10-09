import type { MachineSyncPrefs } from "./machine-sync-types"
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
