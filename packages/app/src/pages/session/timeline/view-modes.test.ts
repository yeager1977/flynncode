import { describe, expect, mock, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { normalizeSessionMessages } from "@/utils/session-message"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  // Mirrors the real renderable() signature closely enough for the fixtures:
  // tool parts stay listable, text needs content, reasoning follows the flag.
  renderable: (part: { type: string; text?: string }, showReasoningSummaries: boolean | undefined) => {
    if (part.type === "tool") return true
    if (part.type === "text") return !!part.text?.trim()
    if (part.type === "reasoning") return !!showReasoningSummaries && !!part.text?.trim()
    return true
  },
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))

const { Timeline, TimelineRow } = await import("./rows")

function fixture() {
  // One turn: user question, then an assistant message with reasoning, text,
  // and a completed tool part.
  const source = [
    { id: "msg_u", type: "user", text: "explain the fix", time: { created: 1 } },
    {
      id: "msg_a",
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [
        { type: "reasoning", text: "thinking about the fix", time: { created: 2 } },
        { type: "text", text: "here is the answer" },
        {
          type: "tool",
          id: "part_tool",
          name: "read",
          state: {
            status: "completed" as const,
            input: { filePath: "a.ts" },
            content: [{ type: "text" as const, text: "file body" }],
            metadata: {},
          },
          time: { created: 3, completed: 4 },
        },
      ],
      time: { created: 2, completed: 30 },
    },
  ] satisfies SessionMessageInfo[]
  const normalized = normalizeSessionMessages("ses_1", source)
  const messages = new Map(normalized.messages.map((message) => [message.id, message]))
  return { source, messages, parts: normalized.parts }
}

const run = (viewMode: "normal" | "thinking" | "verbose") => {
  const { source, messages, parts } = fixture()
  return Timeline.constructSessionMessageRows(
    source,
    (messageID) => messages.get(messageID),
    (messageID) => parts.get(messageID) ?? [],
    false,
    "idle",
    true,
    [...messages.values()].filter((message) => message.role === "user"),
    viewMode,
  )
}

describe("view-mode row construction", () => {
  test("normal keeps the current render: answer text plus collapsed tool rows, no reasoning", () => {
    const result = run("normal")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_u",
      "assistant-part:msg_u:msg_a:text:0",
      "assistant-part:msg_u:part_tool",
    ])
    expect(result.rows.filter((row) => row._tag === "AssistantPart").every((row) => !row.verbose)).toBe(true)
  })

  test("thinking adds the reasoning block in content order", () => {
    const result = run("thinking")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_u",
      "assistant-part:msg_u:msg_a:reasoning:0",
      "assistant-part:msg_u:msg_a:text:0",
      "assistant-part:msg_u:part_tool",
    ])
  })

  test("verbose keeps all part rows and flags them for open tool details", () => {
    const result = run("verbose")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_u",
      "assistant-part:msg_u:msg_a:reasoning:0",
      "assistant-part:msg_u:msg_a:text:0",
      "assistant-part:msg_u:part_tool",
    ])
    expect(result.rows.filter((row) => row._tag === "AssistantPart").every((row) => row.verbose === true)).toBe(true)
  })

  test("thinking mode surfaces reasoning parts even when reasoning summaries are off", () => {
    const { source, messages, parts } = fixture()
    // With reasoning summaries off (the Normal default), reasoning blocks are
    // hidden; Thinking/Verbose mode must render them inline instead, so the
    // busy-turn shimmer row disappears (its parts are already visible).
    const build = (viewMode: "normal" | "thinking") =>
      Timeline.constructSessionMessageRows(
        source,
        (messageID) => messages.get(messageID),
        (messageID) => parts.get(messageID) ?? [],
        false,
        "busy",
        true,
        [...messages.values()].filter((message) => message.role === "user"),
        viewMode,
      )

    const normal = build("normal")
    expect(normal.rows.some((row) => row._tag === "Thinking")).toBe(true)
    expect(normal.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_u",
      "assistant-part:msg_u:msg_a:text:0",
      "assistant-part:msg_u:part_tool",
      "thinking:msg_u",
    ])
    expect(normal.rows.some((row) => row._tag === "AssistantPart" && row.group.key.includes("reasoning"))).toBe(false)

    expect(build("thinking").rows.some((row) => row._tag === "Thinking")).toBe(false)
    expect(
      build("thinking").rows.some((row) => row._tag === "AssistantPart" && row.group.key.includes("reasoning")),
    ).toBe(true)
  })
})