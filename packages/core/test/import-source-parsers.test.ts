import { describe, expect, it } from "bun:test"
import { parseClaudeCode } from "@opencode-ai/core/session/import-source/claude-code"
import { parseCodex } from "@opencode-ai/core/session/import-source/codex"

const line = (value: unknown) => JSON.stringify(value)

describe("core import-source parsers", () => {
  it("parses claude code user and assistant text", () => {
    const text = [
      line({
        type: "user",
        uuid: "u1",
        sessionId: "s1",
        cwd: "/work",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Hello" },
      }),
      line({
        type: "assistant",
        uuid: "a1",
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: "/work",
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      }),
    ].join("\n")
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text })
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(parsed.title).toBe("Hello")
  })

  it("parses codex user text and assistant text from response_item", () => {
    const text = [
      line({ type: "session_meta", payload: { id: "01abc", cwd: "/repo", timestamp: "2026-01-01T00:00:00.000Z" } }),
      line({ type: "event_msg", payload: { type: "user_message", message: "Do it" } }),
      line({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      }),
    ].join("\n")
    const parsed = parseCodex({ path: "/tmp/rollout-1.jsonl", text })
    expect(parsed.sourceSessionID).toBe("01abc")
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("does not throw on malformed lines", () => {
    const parsed = parseClaudeCode({ path: "/tmp/x.jsonl", text: "{not json" })
    expect(parsed.messages).toEqual([])
  })
})