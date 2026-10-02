import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  BULK_PRESETS,
  cleanupCandidates,
  confirmIDs,
  eligibleRoots,
  isOlderThan,
  protectedRootIDs,
  selectLoaded,
  selectRange,
  toggleID,
} from "./session-bulk"

const DAY = 86_400_000
const now = 10 * DAY

const session = (
  input: Omit<Partial<Session>, "time"> & Pick<Session, "id"> & { time?: Partial<Session["time"]> },
): Session =>
  ({
    directory: "/repo",
    title: input.id,
    parentID: input.parentID,
    time: { created: 0, updated: 0, archived: undefined, ...input.time },
    ...input,
  }) as Session

describe("session bulk eligibility", () => {
  test("uses fixed day counts", () => {
    expect(BULK_PRESETS.map((preset) => [preset.id, preset.days])).toEqual([
      ["1w", 7],
      ["2w", 14],
      ["1m", 30],
      ["3m", 90],
      ["6m", 180],
      ["1y", 365],
    ])
  })

  test("keeps a session updated at the exact cutoff", () => {
    const item = session({ id: "exact", time: { created: 0, updated: now - 7 * DAY } })
    expect(isOlderThan(item, now, 7)).toBe(false)
    expect(isOlderThan(session({ id: "old", time: { created: 0, updated: now - 7 * DAY - 1 } }), now, 7)).toBe(true)
  })

  test("falls back to created when updated is missing", () => {
    const item = session({ id: "created", time: { created: now - 14 * DAY - 1, updated: undefined } })
    expect(isOlderThan(item, now, 14)).toBe(true)
  })

  test("drops archived sessions and children from roots", () => {
    const roots = eligibleRoots([
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "gone", time: { created: 0, updated: 0, archived: 1 } }),
    ])
    expect(roots.map((item) => item.id)).toEqual(["root"])
  })

  test("locks open, tabbed, running, pending, and parent of a protected child", () => {
    const sessions = [
      session({ id: "route" }),
      session({ id: "tab" }),
      session({ id: "running" }),
      session({ id: "waiting" }),
      session({ id: "parent" }),
      session({ id: "child", parentID: "parent" }),
      session({ id: "free" }),
    ]
    const blocked = protectedRootIDs(sessions, {
      openRouteID: "route",
      openTabIDs: new Set(["tab"]),
      working: (id) => id === "running" || id === "child",
      pending: (id) => id === "waiting",
    })
    expect([...blocked].sort()).toEqual(["child", "parent", "route", "running", "tab", "waiting"])
  })

  test("locks a root when an open or running child is absent but its parent link is supplied", () => {
    const blocked = protectedRootIDs([session({ id: "root" })], {
      openTabIDs: new Set(["open-child"]),
      working: (id) => id === "running-child",
      pending: () => false,
      parentID: new Map([
        ["open-child", "root"],
        ["running-child", "root"],
      ]),
    })
    expect(blocked.has("root")).toBe(true)
    expect(blocked.has("open-child")).toBe(true)
    expect(blocked.has("running-child")).toBe(true)
  })

  test("cleanup splits old matches from old protected roots", () => {
    const sessions = [
      session({ id: "old", time: { created: 0, updated: 1 } }),
      session({ id: "busy", time: { created: 0, updated: 1 } }),
      session({ id: "fresh", time: { created: 0, updated: now } }),
    ]
    const result = cleanupCandidates(sessions, now, 7, new Set(["busy"]))
    expect(result.match.map((item) => item.id)).toEqual(["old"])
    expect(result.skipped.map((item) => item.id)).toEqual(["busy"])
  })

  test("selection skips ids that are not allowed", () => {
    const allowed = new Set(["a", "c"])
    expect(toggleID(["a"], "b", allowed)).toEqual(["a"])
    expect(toggleID(["a"], "c", allowed)).toEqual(["a", "c"])
    expect(selectLoaded(["a", "b", "c"], allowed)).toEqual(["a", "c"])
    expect(selectRange({ order: ["a", "b", "c"], selected: [], anchor: "a", id: "c", allowed })).toEqual({
      selected: ["a", "c"],
      anchor: "a",
    })
  })

  test("confirm keeps unloaded ids that a loaded allow-list would drop", () => {
    const loaded = new Set(["a", "b"])
    const allowed = new Set(["a"])
    expect(confirmIDs(["a", "b", "unloaded"], loaded, allowed)).toEqual(["a", "unloaded"])
  })

  test("confirm drops an unloaded id that is protected", () => {
    const loaded = new Set(["a"])
    const allowed = new Set(["a"])
    expect(confirmIDs(["a", "unloaded", "other"], loaded, allowed, new Set(["unloaded"]))).toEqual(["a", "other"])
  })
})
