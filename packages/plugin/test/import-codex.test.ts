import { describe, expect, it } from "bun:test"
import { parseCodex } from "../src/import/codex"

const line = (value: unknown) => JSON.stringify(value)

const fixture = [
  line({
    type: "session_meta",
    payload: { id: "01abc", session_id: "01abc", cwd: "/repo", timestamp: "2026-01-01T00:00:00.000Z" },
  }),
  line({ type: "event_msg", payload: { type: "user_message", message: "Do the thing" } }),
  line({ type: "response_item", payload: { type: "reasoning", summary: "thinking" } }),
  line({ type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Done." } }),
  line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
  line({ type: "event_msg", payload: { type: "token_count", info: {} } }),
  line({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Done." } }),
].join("\n")

describe("parseCodex", () => {
  it("reads session metadata", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.sourceSessionID).toBe("01abc")
    expect(parsed.cwd).toBe("/repo")
  })

  it("keeps user and assistant messages in order", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(parsed.messages[0]?.text).toBe("Do the thing")
  })

  it("imports each assistant message exactly once from response_item", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.messages.filter((message) => message.role === "assistant")).toHaveLength(1)
    expect(parsed.messages[1]?.role).toBe("assistant")
    expect(parsed.messages[1]?.text).toBe("Done.")
  })

  it("ignores reasoning and token_count records", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.messages.some((message) => message.text === "thinking")).toBe(false)
  })

  it("derives a title from the first user message", () => {
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text: fixture })
    expect(parsed.title).toBe("Do the thing")
  })
})