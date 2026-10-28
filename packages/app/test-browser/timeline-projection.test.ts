import { describe, expect, mock, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { Part, SessionStatus } from "@flynncode/sdk/v2"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { normalizeSessionMessages } from "@/utils/session-message"
import { TimelineRow } from "@/pages/session/timeline/timeline-row"

// Bun cannot load Vite's `?worker&url` imports, which the real message-part module pulls in.
const sessionUI = new URL("../../session-ui/src/", import.meta.url).pathname
mock.module(`${sessionUI}components/markdown.worker.ts?worker&url`, () => ({ default: "" }))
mock.module("@pierre/diffs/worker/worker.js?worker&url", () => ({ default: "" }))

const { createTimelineProjection } = await import("@/pages/session/timeline/projection")

const turn = (index: number, text: string) =>
  [
    { id: `msg_${index}_user`, type: "user", text: `question ${index}`, time: { created: index * 10 } },
    {
      id: `msg_${index}_assistant`,
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [{ type: "text", text }],
      time: { created: index * 10 + 1 },
    },
  ] satisfies SessionMessageInfo[]

function setup() {
  const source = [...turn(1, "first answer"), ...turn(2, "second answer"), ...turn(3, "streaming")]
  const normalized = normalizeSessionMessages("ses_1", source)
  const [store, setStore] = createStore({ part: Object.fromEntries(normalized.parts) as Record<string, Part[]> })
  const reads: string[] = []
  const busy: SessionStatus = { type: "busy" }
  return createRoot((dispose) => {
    const projection = createTimelineProjection({
      messages: () => normalized.messages,
      userMessages: () => normalized.messages.filter((message) => message.role === "user"),
      sessionMessages: () => source,
      parts: (messageID) => {
        reads.push(messageID)
        return store.part[messageID] ?? []
      },
      status: () => busy,
      showReasoningSummaries: () => true,
      inlineComments: () => true,
    })
    return { projection, reads, setStore, dispose }
  })
}

const activeTurn = ["msg_3_user", "msg_3_assistant"]

describe("createTimelineProjection per-turn rows", () => {
  test("a text delta on a non-empty part rebuilds no rows", () => {
    const ctx = setup()
    const before = ctx.projection.rows()
    ctx.reads.length = 0

    ctx.setStore("part", "msg_3_assistant", 0, "text", (text) => `${text} more tokens`)

    expect(ctx.projection.rows()).toBe(before)
    expect(ctx.reads).toEqual([])
    ctx.dispose()
  })

  test("a new part rebuilds only the active turn and keeps earlier rows", () => {
    const ctx = setup()
    const before = ctx.projection.rows()
    ctx.reads.length = 0

    ctx.setStore("part", "msg_3_assistant", (parts) => [
      ...parts,
      { id: "msg_3_assistant:text:1", sessionID: "ses_1", messageID: "msg_3_assistant", type: "text", text: "next" },
    ])

    const after = ctx.projection.rows()
    expect(new Set(ctx.reads)).toEqual(new Set(activeTurn))
    expect(after.map(TimelineRow.key)).toEqual([
      ...before.map(TimelineRow.key),
      "assistant-part:msg_3_user:part:msg_3_assistant:msg_3_assistant:text:1",
    ])
    before.forEach((row, index) => expect(after[index]).toBe(row))
    ctx.dispose()
  })

  test("a part that becomes non-empty rebuilds only the active turn", () => {
    const ctx = setup()
    ctx.setStore("part", "msg_3_assistant", (parts) => [
      ...parts,
      { id: "msg_3_assistant:text:1", sessionID: "ses_1", messageID: "msg_3_assistant", type: "text", text: " " },
    ])
    const before = ctx.projection.rows()
    ctx.reads.length = 0

    ctx.setStore("part", "msg_3_assistant", 1, "text", "visible")

    expect(new Set(ctx.reads)).toEqual(new Set(activeTurn))
    expect(ctx.projection.rows().map(TimelineRow.key)).toEqual([
      ...before.map(TimelineRow.key),
      "assistant-part:msg_3_user:part:msg_3_assistant:msg_3_assistant:text:1",
    ])
    ctx.dispose()
  })
})
