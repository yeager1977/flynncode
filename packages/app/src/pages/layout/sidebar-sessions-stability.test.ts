import { describe, expect, test } from "bun:test"
import type { Session } from "@flynncode/sdk/v2/client"
import { stableSessions } from "./sidebar-sessions"

const session = (id: string, title: string) =>
  ({
    id,
    slug: id,
    projectID: "prj_1",
    directory: "/repo",
    title,
    version: "1",
    time: { created: 1, updated: 1 },
  }) as Session

describe("stableSessions", () => {
  test("keeps the previous object for a session that did not change", () => {
    const previous = [session("a", "A"), session("b", "B")]
    const next = [session("a", "A"), session("b", "B")]

    const result = stableSessions(previous, next)

    // The same object reference keeps the sidebar row (and an in-progress
    // rename) alive across a refresh.
    expect(result[0]).toBe(previous[0])
    expect(result[1]).toBe(previous[1])
  })

  test("replaces the object when the session changed", () => {
    const previous = [session("a", "A")]
    const next = [session("a", "Renamed")]

    const result = stableSessions(previous, next)

    expect(result[0]).not.toBe(previous[0])
    expect(result[0]?.title).toBe("Renamed")
  })

  test("replaces the object when the title changed", () => {
    const previous = [session("a", "A")]
    const next = [session("a", "A2")]

    expect(stableSessions(previous, next)[0]).not.toBe(previous[0])
  })

  test("adds and removes sessions", () => {
    const previous = [session("a", "A")]
    const next = [session("a", "A"), session("b", "B")]

    const result = stableSessions(previous, next)

    expect(result.map((item) => item.id)).toEqual(["a", "b"])
    expect(result[0]).toBe(previous[0])
  })

  test("does not reuse an object for a different session", () => {
    const previous = [session("a", "A")]
    const next = [session("b", "A")]

    expect(stableSessions(previous, next)[0]).not.toBe(previous[0])
  })

  test("keeps the row when only time.updated changed", () => {
    // A session that received a message gets a new time.updated. The row
    // renders the same thing, so it must not be torn down: that would close
    // an open context menu and drop an in-progress rename.
    const previous = [session("a", "A")]
    const next = [{ ...session("a", "A"), time: { created: 1, updated: 2 } }] as Session[]

    expect(stableSessions(previous, next)[0]).toBe(previous[0])
  })

  test("replaces the row when the session was archived", () => {
    const previous = [session("a", "A")]
    const next = [{ ...session("a", "A"), time: { created: 1, updated: 1, archived: 5 } }] as Session[]

    expect(stableSessions(previous, next)[0]).not.toBe(previous[0])
  })

  test("replaces the row when the main agent changed", () => {
    // The sidebar shows the agent name under the title; a switch must
    // refresh the row.
    const previous = [session("a", "A")]
    const next = [{ ...session("a", "A"), agent: "plan" }] as Session[]

    expect(stableSessions(previous, next)[0]).not.toBe(previous[0])
  })
})
