import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { ComputerUseV1 } from "@opencode-ai/schema/computer-use-v1"
import {
  createComputerUseExecutor,
  type ComputerUseActuation,
  type ComputerUseScreenshot,
  type ComputerUseSurface,
} from "./executor"

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
  screenshot?: (requestID: string, appID: string) => Promise<ComputerUseScreenshot>
  click?: (appID: string, x: number, y: number, requestID: string) => Promise<ComputerUseActuation>
}): ComputerUseSurface => ({
  computerUse: {
    screenshot:
      override?.screenshot ??
      ((): Promise<ComputerUseScreenshot> =>
        Promise.resolve({ status: "performed", screenshot: "data:image/png;base64,AAAA" })),
    click: override?.click ?? ((): Promise<ComputerUseActuation> => Promise.resolve({ status: "performed" })),
    typeText: () => Promise.resolve({ status: "performed" }),
    keypress: () => Promise.resolve({ status: "performed" }),
    scroll: () => Promise.resolve({ status: "performed" }),
  },
})

describe("computer-use executor", () => {
  test("captures a screenshot through the claimed pane surface and replies ok", async () => {
    const replies: Array<{ requestID: string; directory?: string; result: unknown }> = []
    const screenshots: Array<[string, string]> = []
    const executor = createComputerUseExecutor({
      surface: surface({
        screenshot: (requestID, appID) => {
          screenshots.push([requestID, appID])
          return Promise.resolve({ status: "performed", screenshot: "data:image/png;base64,AAAA" })
        },
      }),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    const event = requestEvent({ action: "screenshot", requestID: "cue_test" })
    await executor.handle(event, "/tmp/project")

    expect(screenshots).toEqual([["cue_test", "flynncode:browser-pane"]])
    expect(replies).toHaveLength(1)
    expect(replies[0].requestID).toBe("cue_test")
    expect(replies[0].directory).toBe("/tmp/project")
    expect(replies[0].result).toEqual({ ok: true, screenshot: "data:image/png;base64,AAAA" })
  })

  test("refused actions are reported as ok:false with the desktop's reason", async () => {
    const replies: Array<{ result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface({ click: () => Promise.resolve({ status: "refused", reason: "app is not allowlisted for computer use" }) }),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    await executor.handle(requestEvent({ action: "click", args: { x: 1, y: 2 } }))

    expect(replies[0].result).toEqual({ ok: false, error: "app is not allowlisted for computer use" })
  })

  test("an unavailable window does not reply, so it cannot beat a real executor", async () => {
    const replies: Array<{ result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface({
        click: () => Promise.resolve({ status: "unavailable" }),
        screenshot: () => Promise.resolve({ status: "unavailable" }),
      }),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    await executor.handle(requestEvent({ action: "click", args: { x: 1, y: 2 } }))
    await executor.handle(requestEvent({ action: "screenshot" }))

    // Windows without the claimed pane stay silent: a loser's terminal ok:false
    // reply could otherwise resolve the request while the owner still actuates.
    expect(replies).toEqual([])
  })

  test("sends actuation through the computer-use surface with the appID and requestID", async () => {
    const clicks: Array<[string, number, number, string]> = []
    const replies: Array<{ result: unknown }> = []
    const executor = createComputerUseExecutor({
      surface: surface({
        click: (appID, x, y, requestID) => (clicks.push([appID, x, y, requestID]), Promise.resolve({ status: "performed" })),
      }),
      postReply: async (payload) => {
        replies.push(payload)
      },
    })

    await executor.handle(requestEvent({ action: "click", args: { x: 10, y: 20 }, requestID: "cue_test" }))

    expect(clicks).toEqual([["flynncode:browser-pane", 10, 20, "cue_test"]])
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

  test("surfaces unconfirmed honestly when the reply transport fails after acting", async () => {
    const sent: Array<unknown> = []
    const executor = createComputerUseExecutor({
      surface: surface(),
      postReply: (payload) => {
        sent.push(payload.result)
        // The first (successful-actuation) receipt is lost, like a dead SSE
        // or a refused POST; the second attempt carries the receipt onwards.
        if (sent.length === 1) return Promise.reject(new Error("reply delivery refused"))
        return Promise.resolve()
      },
    })

    await executor.handle(requestEvent({ action: "click", args: { x: 1, y: 2 } }))

    if (sent.length < 2) {
      throw new Error("renderer did not retry with an unconfirmed receipt; it only logged and disappeared")
    }
    expect(sent[1]).toEqual({
      ok: false,
      error: "reply delivery failed after performing the action; the outcome is unconfirmed",
      unconfirmed: true,
    })
  })

  test("listener is wired in the server sdk and gated to the desktop surface", async () => {
    const source = await readFile(path.join(import.meta.dir, "..", "context", "server-sdk.tsx"), "utf8")
    expect(source).toContain('from "@/computer-use/executor"')
    expect(source).toContain("createComputerUseExecutor({")
    expect(source).toContain('platform.platform === "desktop"')
    expect(source).toContain("ServerConnection.local(server)")
    expect(source).toContain("executor.handle(payload")
    expect(source).toContain('"/computer-use/execute/reply"')
  })
})