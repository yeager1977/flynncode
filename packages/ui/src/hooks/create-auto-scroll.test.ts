import { describe, expect, test } from "bun:test"
import { createResizeLock } from "./create-auto-scroll"

describe("createResizeLock", () => {
  test("locks on the first observation so a freshly mounted timeline follows its content", () => {
    expect(createResizeLock()(1000)).toBe(true)
  })

  test("does not lock again while the content height is unchanged", () => {
    const lock = createResizeLock()
    lock(1000)
    expect(lock(1000)).toBe(false)
  })

  test("locks when the content grows, so streaming keeps its same-frame bottom lock", () => {
    const lock = createResizeLock()
    lock(1000)
    expect(lock(1010)).toBe(true)
  })

  test("does not lock when the content shrinks, so a collapsed block cannot feed the loop", () => {
    const lock = createResizeLock()
    lock(1000)
    expect(lock(900)).toBe(false)
  })

  test("locks on regrowth after a shrink, so streaming resumes its follow after a collapse", () => {
    const lock = createResizeLock()
    lock(1000)
    lock(900)
    expect(lock(950)).toBe(true)
  })
})