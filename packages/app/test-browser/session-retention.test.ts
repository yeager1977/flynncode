import { describe, expect, test } from "bun:test"
import type { SessionRetention } from "@flynncode/sdk/v2/client"
import { dict } from "@/i18n/en"
import {
  DEFAULT_CLEANUP_DAYS,
  cleanupDaysFromConfig,
  cleanupDaysFromInput,
  firstRunNotice,
  keepMenu,
  markNoticeShown,
  noticeShown,
  pinLabel,
  retentionHint,
} from "@/utils/session-retention"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const retention = (extra: Partial<SessionRetention> = {}): SessionRetention => ({
  cleanupPeriodDays: 30,
  expiring: [],
  kept: [],
  held: [],
  ...extra,
})

describe("keepMenu", () => {
  test("offers Keep forever on an unkept root and Stop keeping on a kept one", () => {
    expect(keepMenu({ id: "a" }, false)).toEqual({ key: "session.keep.on", keep: true })
    expect(keepMenu({ id: "a" }, true)).toEqual({ key: "session.keep.off", keep: false })
  })

  test("is hidden for sub-agent sessions, which follow their parent", () => {
    expect(keepMenu({ id: "child", parentID: "root" }, false)).toBeUndefined()
    expect(keepMenu({ id: "child", parentID: "root" }, true)).toBeUndefined()
  })

  test("the labels read as the spec's menu items", () => {
    expect(dict["session.keep.on"]).toBe("Keep forever")
    expect(dict["session.keep.off"]).toBe("Stop keeping")
  })
})

describe("pinLabel", () => {
  test("pins kept root sessions as kept and held ones as held by a schedule", () => {
    expect(pinLabel({ id: "a" }, { kept: true, held: false })).toBe("session.keep.pinned")
    expect(pinLabel({ id: "a" }, { kept: false, held: true })).toBe("session.keep.held")
    expect(pinLabel({ id: "a" }, { kept: true, held: true })).toBe("session.keep.pinned")
    expect(pinLabel({ id: "a" }, { kept: false, held: false })).toBeUndefined()
  })

  test("never pins a sub-agent session, which follows its parent", () => {
    expect(pinLabel({ id: "child", parentID: "root" }, { kept: true, held: true })).toBeUndefined()
  })

  test("the tooltips read as the spec says", () => {
    expect(dict["session.keep.pinned"]).toBe("Kept forever")
    expect(dict["session.keep.held"]).toBe("Held by a schedule")
  })
})

describe("retentionHint", () => {
  const entries = (deletesAt: number) => [{ sessionID: "ses_a", deletesAt }]

  test("is absent for a session that is not expiring", () => {
    expect(retentionHint(entries(NOW + DAY), "ses_other", NOW)).toBeUndefined()
    expect(retentionHint([], "ses_a", NOW)).toBeUndefined()
    expect(retentionHint(undefined, "ses_a", NOW)).toBeUndefined()
  })

  test("counts whole days from deletesAt, rounding up", () => {
    expect(retentionHint(entries(NOW + 2 * DAY), "ses_a", NOW)).toEqual({ key: "session.keep.deletesInDays", days: 2 })
    expect(retentionHint(entries(NOW + 2 * DAY + 1), "ses_a", NOW)).toEqual({
      key: "session.keep.deletesInDays",
      days: 3,
    })
    expect(retentionHint(entries(NOW + 3 * DAY), "ses_a", NOW)).toEqual({ key: "session.keep.deletesInDays", days: 3 })
  })

  test("says today or tomorrow instead of 0 or 1 days", () => {
    expect(retentionHint(entries(NOW + DAY), "ses_a", NOW)).toEqual({ key: "session.keep.deletesTomorrow" })
    expect(retentionHint(entries(NOW + DAY - 1), "ses_a", NOW)).toEqual({ key: "session.keep.deletesToday" })
    // Already due: it waits for the next hourly pass.
    expect(retentionHint(entries(NOW - 5), "ses_a", NOW)).toEqual({ key: "session.keep.deletesToday" })
  })

  test("the copy reads as the spec's faint hint", () => {
    expect(dict["session.keep.deletesInDays"].replace("{{days}}", "2")).toBe("deletes in 2 days")
  })
})

describe("cleanupDaysFromInput", () => {
  test("accepts whole numbers of at least 1", () => {
    expect(cleanupDaysFromInput("1")).toBe(1)
    expect(cleanupDaysFromInput(" 30 ")).toBe(30)
    expect(cleanupDaysFromInput("365")).toBe(365)
  })

  test("rejects zero, negatives, fractions and text, as the server schema does", () => {
    for (const text of ["0", "-1", "1.5", "", "abc", "3d", "1e2", "00"])
      expect(cleanupDaysFromInput(text)).toBeUndefined()
  })
})

describe("cleanupDaysFromConfig", () => {
  test("falls back to the server default of 30", () => {
    expect(DEFAULT_CLEANUP_DAYS).toBe(30)
    expect(cleanupDaysFromConfig(undefined)).toBe(30)
    expect(cleanupDaysFromConfig({})).toBe(30)
    expect(cleanupDaysFromConfig({ cleanupPeriodDays: 7 })).toBe(7)
  })
})

describe("firstRunNotice", () => {
  const pending = retention({ firstRunAt: NOW + DAY, pendingFirstRunCount: 25 })

  test("shows once for a delayed pass", () => {
    expect(firstRunNotice(pending, undefined)).toEqual({ count: 25, days: 30, firstRunAt: NOW + DAY })
  })

  test("stays hidden once shown, with no delayed pass, or before the data loads", () => {
    expect(firstRunNotice(pending, NOW + DAY)).toBeUndefined()
    expect(firstRunNotice(retention(), undefined)).toBeUndefined()
    expect(firstRunNotice(retention({ firstRunAt: NOW + DAY, pendingFirstRunCount: 0 }), undefined)).toBeUndefined()
    expect(firstRunNotice(undefined, undefined)).toBeUndefined()
  })

  test("shows again for a later delay, such as after the period was lowered", () => {
    const later = retention({ firstRunAt: NOW + 9 * DAY, pendingFirstRunCount: 30 })
    expect(firstRunNotice(later, NOW + DAY)).toEqual({ count: 30, days: 30, firstRunAt: NOW + 9 * DAY })
  })
})

describe("notice storage", () => {
  test("remembers that the notice was shown", () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, v: string) => void store.set(key, v),
    }
    expect(noticeShown(storage)).toBeUndefined()
    markNoticeShown(NOW + DAY, storage)
    expect(noticeShown(storage)).toBe(NOW + DAY)
    // A profile that saw a notice before delays were remembered by time shows the next one once.
    store.set("flynncode.session-retention.notice-shown", "1")
    expect(
      firstRunNotice(retention({ firstRunAt: NOW + DAY, pendingFirstRunCount: 25 }), noticeShown(storage)),
    ).toBeDefined()
  })

  test("survives storage that throws: the notice shows, remembering fails quietly", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect(noticeShown(storage)).toBeUndefined()
    expect(() => markNoticeShown(NOW + DAY, storage)).not.toThrow()
  })
})
