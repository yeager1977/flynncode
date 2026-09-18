import { describe, expect, it } from "bun:test"
import { parseClaudeCode } from "../src/import/claude-code"

const line = (value: unknown) => JSON.stringify(value)

const fixture = [
  line({ type: "queue-operation", sessionId: "s1" }),
  line({
    type: "user",
    uuid: "u1",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work",
    message: { role: "user", content: "Hello there" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:01.000Z",
    cwd: "/work",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Part one." },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "Part two." },
      ],
    },
  }),
  line({ type: "user", uuid: "u2", sessionId: "s1", isSidechain: true, message: { role: "user", content: "sub" } }),
].join("\n")

describe("parseClaudeCode", () => {
  it("extracts user and assistant text", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: fixture })
    expect(parsed.sourceSessionID).toBe("s1")
    expect(parsed.cwd).toBe("/work")
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(parsed.messages[0]?.text).toBe("Hello there")
  })

  it("joins multiple text blocks with a blank line", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: fixture })
    expect(parsed.messages[1]?.text).toBe("Part one.\n\nPart two.")
  })

  it("excludes sidechain records", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: fixture })
    expect(parsed.messages.some((message) => message.text === "sub")).toBe(false)
  })

  it("skips malformed lines without failing", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: `${fixture}\n{not json` })
    expect(parsed.messages).toHaveLength(2)
  })

  it("derives a title from the first user message", () => {
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text: fixture })
    expect(parsed.title).toBe("Hello there")
  })

  it("drops an automation stub with no human origin and only template prompts", () => {
    const stub = line({
      type: "user",
      uuid: "n1",
      sessionId: "n1",
      cwd: "/home/u/.claude/double-shot-latte",
      timestamp: "2026-01-01T00:00:00.000Z",
      promptSource: "sdk",
      message: {
        role: "user",
        content: "Analyze this conversation and determine: Does the assistant have more autonomous work to do RIGHT NOW?",
      },
    })
    const parsed = parseClaudeCode({ path: "/tmp/n1.jsonl", text: stub })
    expect(parsed.messages).toEqual([])
  })

  it("strips a leading system-reminder block from the title", () => {
    const reminder = line({
      type: "user",
      uuid: "w1",
      sessionId: "w1",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      origin: { kind: "human" },
      message: {
        role: "user",
        content: "<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n\nFix the ingress config",
      },
    })
    const parsed = parseClaudeCode({ path: "/tmp/w1.jsonl", text: reminder })
    expect(parsed.title).toBe("Fix the ingress config")
  })
})