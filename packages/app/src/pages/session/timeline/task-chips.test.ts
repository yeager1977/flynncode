import { describe, expect, mock, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { normalizeSessionMessages } from "@/utils/session-message"

mock.module("@flynncode/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))

const { Timeline, TimelineRow, TaskSuggestion } = await import("./rows")

describe("task-chip envelope parse", () => {
  test("parses title, prompt, and note from an envelope", () => {
    const suggestion = TaskSuggestion.parse(
      [
        "Did the main task.",
        "",
        '<task-suggestion title="Fix flaky CI" prompt="Stabilize the flaky suite">It keeps breaking CI.</task-suggestion>',
      ].join("\n"),
    )
    expect(suggestion).toEqual({
      title: "Fix flaky CI",
      prompt: "Stabilize the flaky suite",
      note: "It keeps breaking CI.",
    })
  })

  test("rejects envelopes missing title or prompt, and plain text", () => {
    expect(TaskSuggestion.parse('<task-suggestion prompt="no title">x</task-suggestion>')).toBeUndefined()
    expect(TaskSuggestion.parse('<task-suggestion title="no prompt">x</task-suggestion>')).toBeUndefined()
    expect(TaskSuggestion.parse("just prose mentioning task-suggestion")).toBeUndefined()
  })

  test("unescapes entities and escaped quotes in attributes", () => {
    const suggestion = TaskSuggestion.parse(
      '<task-suggestion title="Ship &amp; verify" prompt="echo \\"hi&lt;ok\\&gt;">why</task-suggestion>',
    )
    expect(suggestion?.title).toBe('Ship & verify')
    expect(suggestion?.prompt).toBe('echo "hi<ok>')
  })

  test("scans only text parts, newest first", () => {
    const suggestion = TaskSuggestion.fromParts([
      {
        type: "text",
        id: "p1",
        sessionID: "ses_1",
        messageID: "msg_1",
        text: "body text without envelope",
      } as never,
      {
        type: "tool",
        id: "p2",
        sessionID: "ses_1",
        messageID: "msg_1",
        text: '<task-suggestion title="Ignored" prompt="in tool output">x</task-suggestion>',
      } as never,
      {
        type: "text",
        id: "p3",
        sessionID: "ses_1",
        messageID: "msg_1",
        text: '<task-suggestion title="Chip" prompt="do the thing">note</task-suggestion>',
      } as never,
    ])
    expect(suggestion?.title).toBe("Chip")
  })
})

describe("task-chip timeline rows", () => {
  test("renders a chip row after a settled assistant turn with an envelope", () => {
    const source = [
      { id: "msg_u", type: "user", text: "do the main task", time: { created: 1 } },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "text",
            text: 'Done.\n<task-suggestion title="Extract helper" prompt="Extract the shared helper into its own module">Separable cleanup.</task-suggestion>',
          },
        ],
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    const chip = result.rows.at(-1)
    expect(chip?._tag).toBe("TaskSuggestion")
    if (chip?._tag !== "TaskSuggestion") return
    expect(chip.title).toBe("Extract helper")
    expect(chip.prompt).toBe("Extract the shared helper into its own module")
    expect(chip.note).toBe("Separable cleanup.")
    expect(TimelineRow.key(chip)).toContain("task-suggestion:msg_u")
  })

  test("suppresses the chip while the turn is still streaming", () => {
    const source = [
      { id: "msg_u", type: "user", text: "do the main task", time: { created: 1 } },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "text",
            text: '<task-suggestion title="Chip" prompt="work">note</task-suggestion>',
          },
        ],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "busy",
      true,
      normalized.messages.filter((message) => message.role === "user"),
      "normal",
    )

    expect(result.rows.some((row) => row._tag === "TaskSuggestion")).toBe(false)
  })

  test("no chip for replies without an envelope", () => {
    const source = [
      { id: "msg_u", type: "user", text: "hi", time: { created: 1 } },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "plain answer" }],
        time: { created: 2, completed: 3 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.rows.some((row) => row._tag === "TaskSuggestion")).toBe(false)
  })
})

describe("task-chip envelope strip", () => {
  test("removes a trailing envelope and keeps the prose", () => {
    expect(
      TaskSuggestion.strip(
        'Done.\n<task-suggestion title="Extract helper" prompt="Extract the shared helper">Separable cleanup.</task-suggestion>',
      ),
    ).toBe("Done.")
  })

  test("removes the blank line before a trailing envelope", () => {
    expect(
      TaskSuggestion.strip(
        'Done.\n\n<task-suggestion title="T" prompt="P">n</task-suggestion>',
      ),
    ).toBe("Done.")
  })

  test("reduces an envelope-only reply to empty", () => {
    expect(TaskSuggestion.strip('<task-suggestion title="T" prompt="P">n</task-suggestion>')).toBe("")
  })

  test("leaves a mid-text envelope untouched", () => {
    const text = 'A <task-suggestion title="T" prompt="P">n</task-suggestion> B'
    expect(TaskSuggestion.strip(text)).toBe(text)
  })

  test("passes text without an envelope through", () => {
    expect(TaskSuggestion.strip("plain answer")).toBe("plain answer")
  })
})