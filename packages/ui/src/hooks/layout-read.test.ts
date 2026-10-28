import { describe, expect, test } from "bun:test"
import { createLayoutReadPhase } from "./layout-read"

function frames() {
  const queue: Array<() => void> = []
  return {
    request: (flush: () => void) => {
      queue.push(flush)
    },
    pending: () => queue.length,
    run: () => queue.splice(0).forEach((flush) => flush()),
  }
}

describe("createLayoutReadPhase", () => {
  test("coalesces every read scheduled before the frame into one flush", () => {
    const frame = frames()
    const phase = createLayoutReadPhase(frame.request)
    const log: string[] = []

    phase.schedule("thumb", () => void log.push("thumb"))
    phase.schedule("state", () => void log.push("state"))
    phase.schedule("thumb", () => void log.push("thumb again"))

    expect(frame.pending()).toBe(1)
    frame.run()
    expect(log).toEqual(["thumb again", "state"])
  })

  test("runs every read before any write so the frame lays out once", () => {
    const frame = frames()
    const phase = createLayoutReadPhase(frame.request)
    const log: string[] = []

    phase.schedule("thumb", () => {
      log.push("read thumb")
      return () => log.push("write thumb")
    })
    phase.schedule("state", () => {
      log.push("read state")
      return () => log.push("write state")
    })
    frame.run()

    expect(log).toEqual(["read thumb", "read state", "write thumb", "write state"])
  })

  test("a read scheduled while flushing waits for the next frame", () => {
    const frame = frames()
    const phase = createLayoutReadPhase(frame.request)
    const log: string[] = []

    phase.schedule("thumb", () => {
      log.push("first")
      phase.schedule("thumb", () => void log.push("second"))
    })
    frame.run()
    expect(log).toEqual(["first"])
    frame.run()
    expect(log).toEqual(["first", "second"])
  })

  test("a cancelled read does not run", () => {
    const frame = frames()
    const phase = createLayoutReadPhase(frame.request)
    const log: string[] = []

    phase.schedule("thumb", () => void log.push("thumb"))
    phase.cancel("thumb")
    frame.run()

    expect(log).toEqual([])
  })
})
