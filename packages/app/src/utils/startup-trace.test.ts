import { expect, test } from "bun:test"
import { createStartupTrace } from "./startup-trace"

test("records elapsed and delta time per mark", () => {
  let clock = 1000
  const recorded: Array<{ message: string; detail: Record<string, unknown> | undefined }> = []
  const trace = createStartupTrace({
    enabled: true,
    now: () => clock,
    log: (message, detail) => recorded.push({ message, detail }),
  })

  clock = 1250
  trace.mark("route-mounted")
  clock = 5000
  trace.mark("content-ready")

  expect(recorded).toEqual([
    { message: "[startup] route-mounted", detail: { at: 250, since: 250 } },
    { message: "[startup] content-ready", detail: { at: 4000, since: 3750 } },
  ])
})

test("does nothing when disabled", () => {
  const recorded: string[] = []
  const trace = createStartupTrace({ enabled: false, log: (message) => recorded.push(message) })

  trace.mark("content-ready")

  expect(recorded).toEqual([])
})
