import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { ComputerUseV1 } from "@opencode-ai/schema/computer-use-v1"
import { createComputerUseExecutor } from "./executor"

const requestEvent = (input: {
  action: ComputerUseV1.Action
  args?: ComputerUseV1.Args
  requestID?: string
}) => ({
  id: "evt_test",
  type: ComputerUseV1.Event.Requested.type,
  data: {
    requestID: input.requestID ?? ComputerUseV1.ID.ascending(),
    sessionID: "ses_test",
    action: input.action,
    appID: "flynncode:browser-pane",
    ...(input.args ? { args: input.args } : {}),
    time: Date.now(),
  },
})

const surface = (override?: {
  capture?: () => Promise<string | undefined>
  click?: (appID: string, x: number, y: number) => Promise<void>
}) => ({
  computerUse: {
    click: override?.click ?? (() => Promise.resolve()),
    typeText: () => Promise.resolve(),
    keypress: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
  },
  previewHost: {
    capture: override?.capture ?? (() => Promise.resolve("data:image/png;base64,AAAA")),
  },
})

describe("computer-use executor", () => {
  test("captures a screenshot through the preview host and replies ok", async () => {
    const replies: Array<{ requestID: string; directory?: string; result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface(),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    const event = requestEvent({ action: "screenshot" })
    await executor.handle(event, "/tmp/project")

    expect(replies).toHaveLength(1)
    expect(replies[0].requestID).toBe(event.data.requestID)
    expect(replies[0].directory).toBe("/tmp/project")
    expect(replies[0].result).toEqual({ ok: true, screenshot: "data:image/png;base64,AAAA" })
  })

  test("reports a missing preview pane instead of claiming the capture", async () => {
    const replies: Array<{ result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface({ capture: () => Promise.resolve(undefined) }),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    await executor.handle(requestEvent({ action: "screenshot" }))

    expect(replies).toHaveLength(1)
    expect(replies[0].result).toEqual({ ok: false, error: "no preview pane attached to capture" })
  })

  test("sends actuation through the computer-use surface with the appID", async () => {
    const clicks: Array<[string, number, number]> = []
    const replies: Array<{ result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface({ click: (appID, x, y) => (clicks.push([appID, x, y]), Promise.resolve()) }),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    await executor.handle(requestEvent({ action: "click", args: { x: 10, y: 20 } }))

    expect(clicks).toEqual([["flynncode:browser-pane", 10, 20]])
    expect(replies[0].result).toEqual({ ok: true, output: "click sent to flynncode:browser-pane" })
  })

  test("fails closed when required arguments are missing", async () => {
    const replies: Array<{ result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface(),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    await executor.handle(requestEvent({ action: "click" }))

    expect(replies[0].result).toEqual({ ok: false, error: "click requires x and y arguments" })
  })

  test("ignores events that are not computer-use requests", async () => {
    const replies: Array<{ result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface(),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    await executor.handle({ type: "question.v2.asked", data: {} })
    await executor.handle(undefined)

    expect(replies).toEqual([])
  })

  test("surface failures become ok:false errors", async () => {
    const replies: Array<{ result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface({ click: () => Promise.reject(new Error("pane refused the click")) }),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    await executor.handle(requestEvent({ action: "click", args: { x: 1, y: 2 } }))

    expect(replies[0].result).toEqual({ ok: false, error: "pane refused the click" })
  })

  test("listener is wired in the server sdk and gated to the desktop surface", async () => {
    const source = await readFile(
      path.join(import.meta.dir, "..", "context", "server-sdk.tsx"),
      "utf8",
    )
    // The listener only attaches for desktop windows and local servers; the web
    // shell never gains pane-actuation.
    expect(source).toContain('from "@/computer-use/executor"')
    expect(source).toContain("createComputerUseExecutor({")
    expect(source).toContain('platform.platform === "desktop"')
    expect(source).toContain("ServerConnection.local(server)")
    // The desktop main's allowlist gate stays in the loop (appIDs pass through).
    expect(source).toContain("executor.handle(payload")
    expect(source).toContain('"/computer-use/execute/reply"')
  })
})