import { describe, expect, test } from "bun:test"
import { addRoutine, isValidRrule, removeRoutine, routinesFromConfig, routinesToConfig, toggleRoutine, updateRoutine } from "./routines-edit"

describe("routines editor", () => {
  test("reads and writes the stored shape", () => {
    const routines = routinesFromConfig({
      routines: [{ id: "triage", name: "Triage", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    expect(routines[0]?.dailyAt).toBe("09:00")
    expect(routinesToConfig(routines).routines[0]).toMatchObject({
      id: "triage",
      schedule: { dailyAt: "09:00" },
      enabled: true,
    })
  })

  test("round-trips scheduler-owned fields Settings does not edit", () => {
    const stored = {
      id: "watch",
      name: "Watch",
      prompt: "Review changes",
      createdAt: "2026-10-01T00:00:00.000Z",
      directory: "/repo",
      target: { url: "http://deepthought:4096", username: "opencode", password: "secret" },
      trigger: { files: ["src/**/*.ts"] },
    }
    expect(routinesToConfig(routinesFromConfig({ routines: [stored] })).routines[0]).toMatchObject(stored)
  })

  test("updateRoutine sets, keeps, and clears a target", () => {
    const before = routinesFromConfig({
      routines: [{ id: "r1", name: "mornings", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    // url + credentials.
    const withTarget = updateRoutine(before, "r1", { targetUrl: "http://deepthought:4096", targetUser: "opencode", targetPass: "secret" })
    expect(withTarget[0]?.target).toEqual({ url: "http://deepthought:4096", username: "opencode", password: "secret" })
    // A blank password keeps the stored one only while the url is unchanged; a
    // changed url drops credentials so the old host's password is never
    // attached to the new host, and a blank url clears the target entirely.
    const sameHost = updateRoutine(withTarget, "r1", { targetUrl: "http://deepthought:4096", targetUser: "", targetPass: "" })
    expect(sameHost[0]?.target).toEqual({ url: "http://deepthought:4096", password: "secret" })
    const newHost = updateRoutine(withTarget, "r1", { targetUrl: "http://deepthought:5090", targetUser: "", targetPass: "" })
    expect(newHost[0]?.target).toEqual({ url: "http://deepthought:5090" })
    expect(updateRoutine(newHost, "r1", { targetUrl: "", targetUser: "", targetPass: "" })[0]?.target).toBeUndefined()
  })

  test("routinesToConfig and updateRoutine keep passwords verbatim, no trimming", () => {
    const withTarget = updateRoutine(
      routinesFromConfig({
        routines: [{ id: "r1", name: "mornings", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
      }),
      "r1",
      { targetUrl: "http://deepthought:4096", targetPass: " surrounded " },
    )
    expect(withTarget[0]?.target).toEqual({ url: "http://deepthought:4096", password: " surrounded " })
    expect(routinesToConfig(withTarget).routines[0].target).toEqual({ url: "http://deepthought:4096", password: " surrounded " })
    const kept = updateRoutine(withTarget, "r1", { targetUrl: "http://deepthought:4096", targetUser: "opencode" })
    expect(kept[0]?.target).toEqual({ url: "http://deepthought:4096", username: "opencode", password: " surrounded " })
  })

  test("updateRoutine leaves the target untouched when no target field is in the patch", () => {
    const before = routinesFromConfig({
      routines: [
        {
          id: "r1",
          name: "mornings",
          prompt: "Check CI",
          schedule: { dailyAt: "09:00" },
          target: { url: "http://deepthought:4096", password: "secret" },
        },
      ],
    })
    // An edit that only touches the name (target fields absent in the JS sense)
    // must keep the stored target, password included.
    const after = updateRoutine(before, "r1", { name: "renamed" })
    expect(after[0]?.target).toEqual({ url: "http://deepthought:4096", password: "secret" })
  })

  test("addRoutine stores a target from raw host fields", () => {
    const added = addRoutine([], { name: "Triage", prompt: "Check CI", targetUrl: "http://deepthought:4096", targetPass: "secret" })
    expect(added[0]?.target).toEqual({ url: "http://deepthought:4096", password: "secret" })
    expect(addRoutine([], { name: "B", prompt: "go" })[0]?.target).toBeUndefined()
  })

  test("adds, toggles, and removes", () => {
    const added = addRoutine([], { name: "Triage", prompt: "Check CI", dailyAt: "09:00" })
    expect(added[0]?.id).toBe("triage")
    expect(toggleRoutine(added, "triage")[0]?.enabled).toBe(false)
    expect(removeRoutine(added, "triage")).toEqual([])
  })

  test("updateRoutine replaces one routine's schedule fields", () => {
    const before = routinesFromConfig({
      routines: [{ id: "r1", name: "mornings", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    const after = updateRoutine(before, "r1", { rrule: "FREQ=WEEKLY;BYDAY=MO" })
    const target = after[0]
    expect(target?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO")
    expect(target?.dailyAt).toBeUndefined() // one-of constraint
    expect(target?.name).toBe("mornings")
  })

  test("updateRoutine rejects an invalid rrule", () => {
    const before = routinesFromConfig({
      routines: [{ id: "r1", name: "mornings", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    expect(() => updateRoutine(before, "r1", { rrule: "FREQ=" })).toThrow()
  })

  test("updateRoutine clears the schedule when every schedule patch field is absent-valued", () => {
    const before = routinesFromConfig({
      routines: [{ id: "r1", name: "mornings", prompt: "Check CI", schedule: { dailyAt: "09:00" } }],
    })
    const after = updateRoutine(before, "r1", { dailyAt: undefined, interval: undefined, rrule: undefined })
    const target = after[0]
    expect(target?.dailyAt).toBeUndefined()
    expect(target?.interval).toBeUndefined()
    expect(target?.rrule).toBeUndefined()
  })

  test("accepts bare and extended RRULE input like the backend", () => {
    expect(isValidRrule("FREQ=DAILY")).toBe(true)
    expect(isValidRrule("FREQ=WEEKLY;BYDAY=MO")).toBe(true)
    expect(isValidRrule("EVERY=monday")).toBe(false)
    expect(isValidRrule("FREQ=daily")).toBe(false)
    expect(isValidRrule("FREQ=DAILY extra")).toBe(false)
  })
})
