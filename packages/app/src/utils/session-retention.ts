import type { Config, Session, SessionRetention, SessionRetentionExpiring } from "@flynncode/sdk/v2/client"

const DAY = 24 * 60 * 60 * 1000

// Mirror of the server default in packages/core/src/v1/config/config.ts: an unset
// `cleanupPeriodDays` is 30, so the settings row shows what the server resolves.
export const DEFAULT_CLEANUP_DAYS = 30

const NOTICE_KEY = "flynncode.session-retention.notice-shown"

type KeepTarget = Pick<Session, "id" | "parentID">
type NoticeStorage = Pick<Storage, "getItem" | "setItem">

// Keep lives on the root session; a sub-agent follows its parent, and the server
// answers 400 for one, so the menu item is not offered there.
export function keepMenu(session: KeepTarget, kept: boolean) {
  if (session.parentID) return
  return kept ? ({ key: "session.keep.off", keep: false } as const) : ({ key: "session.keep.on", keep: true } as const)
}

export function showPin(session: KeepTarget, kept: boolean) {
  return kept && !session.parentID
}

// `deletesAt` rounds up to whole days. Under a day, or already due and waiting
// for the next hourly pass, reads "today".
export function retentionHint(
  expiring: readonly SessionRetentionExpiring[] | undefined,
  sessionID: string,
  now: number,
) {
  const entry = expiring?.find((item) => item.sessionID === sessionID)
  if (!entry) return
  const remaining = entry.deletesAt - now
  if (remaining < DAY) return { key: "session.keep.deletesToday" } as const
  const days = Math.ceil(remaining / DAY)
  if (days === 1) return { key: "session.keep.deletesTomorrow" } as const
  return { key: "session.keep.deletesInDays", days } as const
}

// The server schema (a positive integer) stays the authority; this only keeps an
// invalid draft from being written.
export function cleanupDaysFromInput(text: string) {
  const trimmed = text.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return
  const days = Number(trimmed)
  return Number.isSafeInteger(days) ? days : undefined
}

export function cleanupDaysFromConfig(config: Pick<Config, "cleanupPeriodDays"> | undefined) {
  return config?.cleanupPeriodDays ?? DEFAULT_CLEANUP_DAYS
}

// The notice is for a delayed first pass only: `firstRunAt` and a pending count
// are present while it waits.
export function firstRunNotice(retention: SessionRetention | undefined, shown: boolean) {
  if (shown || !retention || retention.firstRunAt === undefined) return
  const count = retention.pendingFirstRunCount ?? 0
  if (count <= 0) return
  return { count, days: retention.cleanupPeriodDays, firstRunAt: retention.firstRunAt }
}

export function noticeShown(storage: NoticeStorage = localStorage) {
  try {
    return storage.getItem(NOTICE_KEY) === "1"
  } catch {
    return false
  }
}

export function markNoticeShown(storage: NoticeStorage = localStorage) {
  try {
    storage.setItem(NOTICE_KEY, "1")
  } catch {
    // Storage can be blocked or full. The notice then returns on the next launch, only while the delay lasts.
  }
}
