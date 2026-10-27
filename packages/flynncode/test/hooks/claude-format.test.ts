import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ClaudeFormat } from "../../src/hooks/claude-format"
import { HooksConfig } from "../../src/hooks/config"
import { ConfigClaude } from "../../src/config/claude"
import { Parameters as ReadParameters } from "../../src/tool/read"
import { Parameters as WriteParameters } from "../../src/tool/write"
import { Parameters as EditParameters } from "../../src/tool/edit"
import { Parameters as MultiEditParameters } from "../../src/tool/multiedit"
import { Parameters as NotebookEditParameters } from "../../src/tool/notebook-edit"
import { Parameters as GlobParameters } from "../../src/tool/glob"
import { Parameters as GrepParameters } from "../../src/tool/grep"
import { Parameters as WebFetchParameters } from "../../src/tool/webfetch"
import { Parameters as WebSearchParameters } from "../../src/tool/websearch"
import { Parameters as TodoParameters } from "../../src/tool/todo"
import { Parameters as QuestionParameters } from "../../src/tool/question"
import { Parameters as ShellParameters } from "../../src/tool/shell/prompt"
import { Parameters as TaskParameters } from "../../src/tool/task"

const extra = { transcriptPath: "/t.jsonl", permissionMode: "default", cwd: "/work" }

describe("ClaudeFormat tool names", () => {
  test("translated tools get their Claude names", () => {
    expect(ClaudeFormat.toolName("bash")).toBe("Bash")
    expect(ClaudeFormat.toolName("edit")).toBe("Edit")
    expect(ClaudeFormat.toolName("write")).toBe("Write")
    expect(ClaudeFormat.toolName("multiedit")).toBe("MultiEdit")
    expect(ClaudeFormat.toolName("notebook_edit")).toBe("NotebookEdit")
    expect(ClaudeFormat.toolName("task")).toBe("Task")
    expect(ClaudeFormat.toolName("question")).toBe("AskUserQuestion")
  })

  test("unknown tools pass through under their Flynncode id", () => {
    expect(ClaudeFormat.toolName("apply_patch")).toBe("apply_patch")
    expect(ClaudeFormat.toolName("constructor")).toBe("constructor")
  })

  test("MCP tools become mcp__<server>__<tool>", () => {
    expect(ClaudeFormat.mcpToolName("my-server", "do_thing")).toBe("mcp__my-server__do_thing")
  })

  test("every Claude tool the compat pack maps has a tool id here", () => {
    const names = ["read", "write", "edit", "multiedit", "bash", "glob", "grep", "webfetch", "websearch", "todowrite", "task", "notebook_edit", "question"].map(
      ClaudeFormat.toolName,
    )
    expect(names.toSorted()).toEqual(Object.keys(ConfigClaude.TOOLS).toSorted())
  })
})

describe("ClaudeFormat arguments", () => {
  test("camelCase keys of translated tools become snake_case", () => {
    expect(ClaudeFormat.toClaudeArgs("edit", { filePath: "/a", oldString: "x", newString: "y", replaceAll: true })).toEqual({
      file_path: "/a",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    })
  })

  test("untranslated tools keep their keys", () => {
    expect(ClaudeFormat.toClaudeArgs("srv_tool", { someKey: 1 })).toEqual({ someKey: 1 })
    expect(ClaudeFormat.fromClaudeArgs("srv_tool", { some_key: 1 })).toEqual({ args: { some_key: 1 }, dropped: [] })
  })

  test("updatedInput maps back and drops keys the tool does not take", () => {
    expect(
      ClaudeFormat.fromClaudeArgs("edit", { file_path: "/a", old_string: "x", new_string: "y", bogus: 1 }),
    ).toEqual({ args: { filePath: "/a", oldString: "x", newString: "y" }, dropped: ["bogus"] })
    // Bash keeps its own snake_case parameter.
    expect(ClaudeFormat.fromClaudeArgs("bash", { command: "ls", run_in_background: true, description: "x" })).toEqual({
      args: { command: "ls", run_in_background: true },
      dropped: ["description"],
    })
  })

  const schemas: Array<[string, Schema.Struct<Schema.Struct.Fields>]> = [
    ["read", ReadParameters],
    ["write", WriteParameters],
    ["edit", EditParameters],
    ["multiedit", MultiEditParameters],
    ["notebook_edit", NotebookEditParameters],
    ["glob", GlobParameters],
    ["grep", GrepParameters],
    ["webfetch", WebFetchParameters],
    ["websearch", WebSearchParameters],
    ["todowrite", TodoParameters],
    ["question", QuestionParameters],
    ["bash", ShellParameters],
    ["task", TaskParameters],
  ]
  for (const entry of schemas) {
    test(`${entry[0]} parameters round-trip through Claude names`, () => {
      const args = Object.fromEntries(Object.keys(entry[1].fields).map((key) => [key, key]))
      expect(ClaudeFormat.fromClaudeArgs(entry[0], ClaudeFormat.toClaudeArgs(entry[0], args))).toEqual({ args, dropped: [] })
    })
  }
})

describe("ClaudeFormat input", () => {
  test("PreToolUse carries the common and tool fields only", () => {
    const stdin = ClaudeFormat.input(
      "PreToolUse",
      { event: "PreToolUse", sessionID: "ses_1", tool: "edit", callID: "c1", args: { filePath: "/a" }, cwd: "/x", model: "m" },
      extra,
    )
    expect(stdin).toEqual({
      session_id: "ses_1",
      transcript_path: "/t.jsonl",
      cwd: "/work",
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/a" },
      tool_use_id: "c1",
    })
  })

  test("an explicit Claude tool name wins over the translated id", () => {
    const stdin = ClaudeFormat.input("PreToolUse", { sessionID: "s", tool: "srv_t", callID: "c", args: {} }, {
      ...extra,
      toolName: "mcp__srv__t",
    })
    expect(stdin["tool_name"]).toBe("mcp__srv__t")
  })

  test("per-event fields", () => {
    const pick = (event: string, payload: Record<string, unknown>) => {
      const stdin = ClaudeFormat.input(event, { sessionID: "s", ...payload }, extra)
      return Object.fromEntries(
        Object.entries(stdin).filter(
          (entry) => !["session_id", "transcript_path", "cwd", "permission_mode", "hook_event_name"].includes(entry[0]),
        ),
      )
    }
    expect(pick("PostToolUse", { tool: "bash", callID: "c", args: { command: "ls" }, output: "a" })).toEqual({
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "c",
      tool_response: "a",
    })
    expect(pick("PostToolUseFailure", { tool: "bash", callID: "c", args: {}, error: "boom", isInterrupt: true })).toEqual({
      tool_name: "Bash",
      tool_input: {},
      tool_use_id: "c",
      error: "boom",
      is_interrupt: true,
    })
    expect(pick("UserPromptSubmit", { prompt: "hi" })).toEqual({ prompt: "hi" })
    expect(pick("SessionStart", { source: "startup" })).toEqual({ source: "startup" })
    expect(pick("SessionEnd", { reason: "other" })).toEqual({ reason: "other" })
    expect(pick("PreCompact", { trigger: "auto", phase: "pre" })).toEqual({ trigger: "auto", custom_instructions: "" })
    expect(pick("Stop", { reason: "idle" })).toEqual({ stop_hook_active: false })
    expect(pick("SubagentStart", { agentID: "a1", agentType: "explore" })).toEqual({ agent_id: "a1", agent_type: "explore" })
    expect(pick("SubagentStop", { agentID: "a1", agentType: "explore", stopHookActive: true })).toEqual({
      stop_hook_active: true,
      agent_id: "a1",
      agent_type: "explore",
    })
    expect(pick("Notification", { message: "waiting", notificationType: "idle" })).toEqual({
      message: "waiting",
      notification_type: "idle",
    })
  })

  test("permission modes map onto Claude's", () => {
    expect(ClaudeFormat.permissionMode("manual")).toBe("default")
    expect(ClaudeFormat.permissionMode("accept-edits")).toBe("acceptEdits")
    expect(ClaudeFormat.permissionMode("auto")).toBe("auto")
    expect(ClaudeFormat.permissionMode(undefined)).toBe("default")
    expect(ClaudeFormat.permissionMode("weird")).toBe("default")
  })
})

describe("ClaudeFormat output", () => {
  const run = (exitCode: number | null, stdout = "", stderr = "") => ({ exitCode, stdout, stderr })
  const json = (value: unknown) => run(0, JSON.stringify(value))

  test("exit 2 by event", () => {
    expect(ClaudeFormat.output("PreToolUse", run(2, "out", " why \n"))).toEqual({
      kind: "decision",
      decision: { behavior: "deny", message: "why" },
    })
    expect(ClaudeFormat.output("PermissionRequest", run(2, "", "no"))).toEqual({
      kind: "decision",
      decision: { behavior: "deny", message: "no" },
    })
    expect(ClaudeFormat.output("PostToolUse", run(2, "", "fix it"))).toEqual({ kind: "post", blocked: true, reason: "fix it" })
    expect(ClaudeFormat.output("PostToolUseFailure", run(2, "", "fix it"))).toEqual({
      kind: "post",
      blocked: true,
      reason: "fix it",
    })
    expect(ClaudeFormat.output("UserPromptSubmit", run(2, "", "secret"))).toEqual({
      kind: "observe",
      observe: {},
      block: "secret",
    })
    expect(ClaudeFormat.output("Stop", run(2, "", "keep going"))).toEqual({ kind: "observe", observe: {}, block: "keep going" })
    expect(ClaudeFormat.output("SubagentStop", run(2))).toEqual({ kind: "observe", observe: {}, block: "Blocked by hook" })
    expect(ClaudeFormat.output("SessionStart", run(2, "", "x"))).toEqual({ kind: "observe", observe: {} })
  })

  test("other exits, timeouts and spawn failures are non-blocking", () => {
    expect(ClaudeFormat.output("PreToolUse", run(1, "", "boom"))).toEqual({ kind: "decision", decision: { behavior: "undecided" } })
    expect(ClaudeFormat.output("PreToolUse", run(null))).toEqual({ kind: "decision", decision: { behavior: "undecided" } })
    expect(ClaudeFormat.output("PostToolUse", run(127))).toEqual({ kind: "post", blocked: false })
    expect(ClaudeFormat.output("SessionStart", run(1, "context"))).toEqual({ kind: "observe", observe: {} })
  })

  test("permissionDecision allow, deny and ask", () => {
    expect(
      ClaudeFormat.output(
        "PreToolUse",
        json({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { file_path: "/a" }, additionalContext: "ctx" } }),
      ),
    ).toEqual({ kind: "decision", decision: { behavior: "allow", updatedInput: { file_path: "/a" }, additionalContext: "ctx" } })
    expect(
      ClaudeFormat.output("PreToolUse", json({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope" } })),
    ).toEqual({ kind: "decision", decision: { behavior: "deny", message: "nope" } })
    expect(ClaudeFormat.output("PreToolUse", json({ hookSpecificOutput: { permissionDecision: "deny" } }))).toEqual({
      kind: "decision",
      decision: { behavior: "deny", message: "Denied by hook" },
    })
    expect(
      ClaudeFormat.output("PreToolUse", json({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "check" } })),
    ).toEqual({ kind: "decision", decision: { behavior: "ask", message: "check" } })
    expect(ClaudeFormat.output("PreToolUse", json({ hookSpecificOutput: { additionalContext: "c" } }))).toEqual({
      kind: "decision",
      decision: { behavior: "undecided", additionalContext: "c" },
    })
  })

  test("legacy PreToolUse decisions and PermissionRequest decisions", () => {
    expect(ClaudeFormat.output("PreToolUse", json({ decision: "block", reason: "old" }))).toEqual({
      kind: "decision",
      decision: { behavior: "deny", message: "old" },
    })
    expect(ClaudeFormat.output("PreToolUse", json({ decision: "approve" }))).toEqual({
      kind: "decision",
      decision: { behavior: "allow" },
    })
    expect(
      ClaudeFormat.output(
        "PermissionRequest",
        json({ hookSpecificOutput: { decision: { behavior: "allow", updatedInput: { command: "ls" } } } }),
      ),
    ).toEqual({ kind: "decision", decision: { behavior: "allow", updatedInput: { command: "ls" } } })
    expect(
      ClaudeFormat.output("PermissionRequest", json({ hookSpecificOutput: { decision: { behavior: "deny", message: "m" } } })),
    ).toEqual({ kind: "decision", decision: { behavior: "deny", message: "m" } })
  })

  test("PostToolUse block and context", () => {
    expect(ClaudeFormat.output("PostToolUse", json({ decision: "block", reason: "lint failed" }))).toEqual({
      kind: "post",
      blocked: true,
      reason: "lint failed",
    })
    expect(ClaudeFormat.output("PostToolUse", json({ hookSpecificOutput: { additionalContext: "note" } }))).toEqual({
      kind: "post",
      blocked: false,
      additionalContext: "note",
    })
    expect(ClaudeFormat.output("PostToolUse", run(0, "plain text"))).toEqual({ kind: "post", blocked: false })
  })

  test("observe fields, blocks and plain text", () => {
    expect(
      ClaudeFormat.output(
        "SessionStart",
        json({ continue: false, stopReason: "halt", systemMessage: "hey", hookSpecificOutput: { additionalContext: "ctx" } }),
      ),
    ).toEqual({
      kind: "observe",
      observe: { additionalContext: "ctx", systemMessage: "hey", continue: false, stopReason: "halt" },
    })
    expect(ClaudeFormat.output("UserPromptSubmit", json({ decision: "block", reason: "no secrets" }))).toEqual({
      kind: "observe",
      observe: {},
      block: "no secrets",
    })
    expect(ClaudeFormat.output("Stop", json({ decision: "block", reason: "tests fail" }))).toEqual({
      kind: "observe",
      observe: {},
      block: "tests fail",
    })
    // decision:block only blocks the events that can block.
    expect(ClaudeFormat.output("SessionStart", json({ decision: "block", reason: "x" }))).toEqual({ kind: "observe", observe: {} })
    expect(ClaudeFormat.output("SessionStart", run(0, " docs live here \n"))).toEqual({
      kind: "observe",
      observe: { additionalContext: "docs live here" },
    })
    expect(ClaudeFormat.output("UserPromptSubmit", run(0, "today is Monday"))).toEqual({
      kind: "observe",
      observe: { additionalContext: "today is Monday" },
    })
    expect(ClaudeFormat.output("Stop", run(0, "plain"))).toEqual({ kind: "observe", observe: {} })
    expect(ClaudeFormat.output("SessionStart", run(0, ""))).toEqual({ kind: "observe", observe: {} })
  })
})

describe("Claude matchers", () => {
  test("plain names and lists match whole names; anything else is a regex", () => {
    expect(HooksConfig.matchesClaudeMatcher("Edit", "Edit|Write")).toBe(true)
    expect(HooksConfig.matchesClaudeMatcher("Write", "Edit|Write")).toBe(true)
    expect(HooksConfig.matchesClaudeMatcher("MultiEdit", "Edit")).toBe(false)
    expect(HooksConfig.matchesClaudeMatcher("NotebookEdit", "Notebook.*")).toBe(true)
    expect(HooksConfig.matchesClaudeMatcher("mcp__srv__t", "mcp__.*")).toBe(true)
    expect(HooksConfig.matchesClaudeMatcher("Bash", "mcp__.*")).toBe(false)
    expect(HooksConfig.matchesClaudeMatcher("Bash", undefined)).toBe(true)
    expect(HooksConfig.matchesClaudeMatcher("Bash", "")).toBe(true)
    expect(HooksConfig.matchesClaudeMatcher("Bash", "*")).toBe(true)
    expect(HooksConfig.matchesClaudeMatcher("Bash", "(")).toBe(false)
  })
})
