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

  it("keeps a session with a human-origin user record", () => {
    const text = line({
      type: "user",
      uuid: "u1",
      sessionId: "h1",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      origin: { kind: "human" },
      message: { role: "user", content: "Real work please" },
    })
    const parsed = parseClaudeCode({ path: "/tmp/h1.jsonl", text })
    expect(parsed.messages.map((m) => m.text)).toEqual(["Real work please"])
  })

  it("keeps a session whose only user record has real text and no human origin", () => {
    const text = line({
      type: "user",
      uuid: "u1",
      sessionId: "r1",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      promptSource: "sdk",
      message: { role: "user", content: "Using chrome run the demo scenes" },
    })
    const parsed = parseClaudeCode({ path: "/tmp/r1.jsonl", text })
    expect(parsed.messages.map((m) => m.text)).toEqual(["Using chrome run the demo scenes"])
  })

  it("drops an automation stub that has no human origin and only template prompts", () => {
    const text = [
      line({
        type: "user",
        uuid: "u1",
        sessionId: "n1",
        cwd: "/home/u/.claude/double-shot-latte",
        timestamp: "2026-01-01T00:00:00.000Z",
        promptSource: "sdk",
        message: { role: "user", content: "Analyze this conversation and determine: Does the assistant have more autonomous work to do RIGHT NOW?" },
      }),
      line({
        type: "assistant",
        uuid: "a1",
        sessionId: "n1",
        cwd: "/home/u/.claude/double-shot-latte",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Failed to authenticate: OAuth session expired" }] },
      }),
    ].join("\n")
    const parsed = parseClaudeCode({ path: "/tmp/n1.jsonl", text })
    expect(parsed.messages).toEqual([])
  })

  it("drops a stub whose only prompt is structured-output enforcement", () => {
    const text = line({
      type: "user",
      uuid: "u1",
      sessionId: "n2",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      isMeta: true,
      message: { role: "user", content: "[structured-output-enforce] You MUST call the StructuredOutput tool to" },
    })
    const parsed = parseClaudeCode({ path: "/tmp/n2.jsonl", text })
    expect(parsed.messages).toEqual([])
  })

  it("strips a leading system-reminder block from the title", () => {
    const text = line({
      type: "user",
      uuid: "u1",
      sessionId: "w1",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      origin: { kind: "human" },
      message: {
        role: "user",
        content:
          "<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n\nFix the ingress controller config",
      },
    })
    const parsed = parseClaudeCode({ path: "/tmp/w1.jsonl", text })
    expect(parsed.title).toBe("Fix the ingress controller config")
  })
})