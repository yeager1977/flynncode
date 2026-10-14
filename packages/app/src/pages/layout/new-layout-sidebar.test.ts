import { describe, expect, test } from "bun:test"
import { visibleSessionOrder } from "./new-layout-sidebar"

describe("visibleSessionOrder", () => {
  test("flattens expanded projects in order and skips collapsed ones", () => {
    expect(
      visibleSessionOrder([
        { expanded: true, sessions: ["a1", "a2"] },
        { expanded: false, sessions: ["b1"] },
        { expanded: true, sessions: ["c1"] },
      ]),
    ).toEqual(["a1", "a2", "c1"])
  })
  test("empty when nothing is expanded", () => {
    expect(visibleSessionOrder([{ expanded: false, sessions: ["a"] }])).toEqual([])
  })
})
