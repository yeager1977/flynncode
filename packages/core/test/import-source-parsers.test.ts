import { describe, expect, it } from "bun:test"
import { parseClaudeCode } from "@flynncode/core/session/import-source/claude-code"
import { codexThreadNames, parseCodex } from "@flynncode/core/session/import-source/codex"

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

describe("claude code import noise", () => {
  const record = (patch: Record<string, unknown>, content: unknown) =>
    line({
      type: "user",
      sessionId: "noise",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content },
      ...patch,
    })

  it("skips meta, slash-command wrapper, and compact summary records", () => {
    const text = [
      record({ isMeta: true }, "Caveat: The messages below were generated by the user while running local commands."),
      record({}, "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
      record({}, "<local-command-stdout></local-command-stdout>"),
      record({ isCompactSummary: true }, "This session is being continued from a previous conversation."),
      record({ origin: { kind: "human" } }, "Fix the flaky test"),
    ].join("\n")
    const parsed = parseClaudeCode({ path: "/tmp/noise.jsonl", text })
    expect(parsed.title).toBe("Fix the flaky test")
    expect(parsed.messages.map((m) => m.text)).toEqual(["Fix the flaky test"])
    expect(parsed.messageCount).toBe(1)
  })
})
describe("codex desktop transcripts", () => {
  const meta = (payload: Record<string, unknown>) =>
    line({ timestamp: "2026-10-13T18:36:53.000Z", type: "session_meta", payload: { id: "01main", cwd: "/repo", ...payload } })
  const userItem = (text: string) =>
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })
  const assistantItem = (text: string) =>
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })

  it("imports user prompts sent as input_text and skips injected context", () => {
    const text = [
      meta({}),
      line({
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<app-context>..." }] },
      }),
      userItem("# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>"),
      userItem('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
      userItem("<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"),
      userItem("The adapters may not be built into the gateway."),
      assistantItem("I'll review the gateway."),
      userItem("No, they must talk to IDX."),
    ].join("\n")
    const parsed = parseCodex({ path: "/tmp/rollout-2026-10-13T14-36-53-01main.jsonl", text })
    expect(parsed.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "The adapters may not be built into the gateway."],
      ["assistant", "I'll review the gateway."],
      ["user", "No, they must talk to IDX."],
    ])
    expect(parsed.title).toBe("The adapters may not be built into the gateway.")
  })

  it("does not duplicate a prompt recorded both as event_msg and response_item", () => {
    const text = [
      meta({}),
      line({ type: "event_msg", payload: { type: "user_message", message: "Do it" } }),
      userItem("Do it"),
      assistantItem("Done."),
    ].join("\n")
    const parsed = parseCodex({ path: "/tmp/rollout-dup.jsonl", text })
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("drops subagent threads", () => {
    const text = [
      meta({ thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: "01parent" } } } }),
      userItem("Review the extraction."),
      assistantItem("No findings."),
    ].join("\n")
    const parsed = parseCodex({ path: "/tmp/rollout-sub.jsonl", text })
    expect(parsed.messageCount).toBe(0)
    expect(parsed.messages).toEqual([])
  })

  it("reads the latest thread name per id from session_index.jsonl", () => {
    const names = codexThreadNames([
      line({ id: "01main", thread_name: "First name", updated_at: "2026-10-13T18:00:00Z" }),
      "{not json",
      line({ id: "01other", thread_name: "Other" }),
      line({ id: "01main", thread_name: "Add standalone EIDO adapter package", updated_at: "2026-10-13T18:38:43Z" }),
      line({ id: "01blank", thread_name: "   " }),
    ])
    expect(names.get("01main")).toBe("Add standalone EIDO adapter package")
    expect(names.get("01other")).toBe("Other")
    expect(names.has("01blank")).toBe(false)
  })
})

describe("claude code custom titles", () => {
  it("uses the latest custom-title record as the title", () => {
    const text = [
      line({
        type: "user",
        sessionId: "s1",
        cwd: "/work",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "getting this error on the new build" },
      }),
      line({ type: "custom-title", customTitle: "path.resolve TypeError", sessionId: "s1" }),
      line({ type: "custom-title", customTitle: "path.resolve TypeError in build", sessionId: "s1" }),
    ].join("\n")
    expect(parseClaudeCode({ path: "/tmp/s1.jsonl", text }).title).toBe("path.resolve TypeError in build")
  })
})

describe("claude code custom-title prefilter", () => {
  it("keeps a user message that merely mentions a custom-title record", () => {
    const text = line({
      type: "user",
      sessionId: "s1",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: 'why does {"type":"custom-title"} show up here?' },
    })
    const parsed = parseClaudeCode({ path: "/tmp/s1.jsonl", text })
    expect(parsed.messages.map((m) => m.role)).toEqual(["user"])
  })
})
