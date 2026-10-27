import { describe, expect, test } from "bun:test"
import { claudeSourceRows, trustRows } from "@/components/settings-v2/hooks-payload"
import { offersAlwaysApproval, permissionHookReason } from "@/pages/session/composer/permission-dock-state"
import { hookBlockReason } from "@/utils/server-errors"

const project = "claude:project:/repo/.claude"
const plugin = "claude:plugin:latte@market"

const sources = [
  {
    id: "claude:user",
    kind: "user" as const,
    label: "Claude Code user settings",
    root: "/home/me/.claude",
    events: ["PreToolUse", "Stop"],
    commands: ["check.sh", "stop.sh"],
    enabled: true,
    warnings: [],
  },
  {
    id: project,
    kind: "project" as const,
    label: "Claude Code project settings (/repo/.claude)",
    events: ["PreToolUse"],
    commands: ["lint.sh"],
    enabled: false,
    warnings: ["unsupported hook event TeammateIdle"],
  },
  {
    id: plugin,
    kind: "plugin" as const,
    label: "Claude Code plugin latte",
    events: ["Stop"],
    commands: ["${CLAUDE_PLUGIN_ROOT}/stop.sh"],
    enabled: true,
    warnings: [],
  },
]

const entries = [
  { hash: "a", event: "PreToolUse", matcher: "", summary: "native.sh", trusted: false, managed: false },
  {
    hash: "b",
    event: "PreToolUse",
    matcher: "Bash",
    summary: "check.sh",
    trusted: true,
    managed: false,
    source: "claude:user",
  },
  { hash: "c", event: "Stop", matcher: "", summary: "stop.sh", trusted: false, managed: false, source: plugin },
  {
    hash: "d",
    event: "Stop",
    matcher: "",
    summary: "gone.sh",
    trusted: false,
    managed: false,
    source: "claude:plugin:gone@m",
  },
]

describe("Claude Code hook sources section", () => {
  test("trust rows name the Claude source they came from", () => {
    expect(trustRows(entries, sources).map((row) => row.source)).toEqual([
      undefined,
      "Claude Code user settings",
      "Claude Code plugin latte",
      "claude:plugin:gone@m",
    ])
  })

  test("source rows keep server order and count hooks awaiting review per source", () => {
    expect(claudeSourceRows(sources, trustRows(entries, sources))).toEqual([
      {
        id: "claude:user",
        kind: "user",
        label: "Claude Code user settings",
        events: ["PreToolUse", "Stop"],
        commands: ["check.sh", "stop.sh"],
        warnings: [],
        enabled: true,
        pending: 0,
      },
      {
        id: project,
        kind: "project",
        label: "Claude Code project settings (/repo/.claude)",
        events: ["PreToolUse"],
        commands: ["lint.sh"],
        warnings: ["unsupported hook event TeammateIdle"],
        enabled: false,
        pending: 0,
      },
      {
        id: plugin,
        kind: "plugin",
        label: "Claude Code plugin latte",
        events: ["Stop"],
        commands: ["${CLAUDE_PLUGIN_ROOT}/stop.sh"],
        warnings: [],
        enabled: true,
        pending: 1,
      },
    ])
  })
})

const request = (input: { permission?: string; always?: string[]; metadata?: Record<string, unknown> }) => ({
  id: "per_1",
  sessionID: "ses_1",
  permission: input.permission ?? "bash",
  patterns: ["ls"],
  metadata: input.metadata ?? {},
  always: input.always ?? ["ls *"],
})

describe("permission dock", () => {
  test("shows a hook's reason from the request metadata", () => {
    expect(permissionHookReason(request({ metadata: { reason: "  review rm commands  " } }))).toBe("review rm commands")
    expect(permissionHookReason(request({ metadata: { reason: "" } }))).toBeUndefined()
    expect(permissionHookReason(request({ metadata: { reason: 42 } }))).toBeUndefined()
    expect(permissionHookReason(request({}))).toBeUndefined()
  })

  test("offers Allow always only when the request has patterns to remember", () => {
    expect(offersAlwaysApproval(request({}))).toBe(true)
    expect(offersAlwaysApproval(request({ always: [] }))).toBe(false)
    expect(offersAlwaysApproval(request({ permission: "computer_use" }))).toBe(false)
  })
})

describe("hookBlockReason", () => {
  test("reads the prompt_async session.error message", () => {
    expect(hookBlockReason({ name: "UnknownError", data: { message: "Prompt blocked by hook: no secrets" } })).toBe(
      "no secrets",
    )
    expect(hookBlockReason({ name: "UnknownError", data: { message: "something else" } })).toBeUndefined()
  })

  test("reads the sync route's PromptBlockedError, raw or wrapped by the client", () => {
    const blocked = { name: "PromptBlockedError", data: { message: "no secrets" } }
    expect(hookBlockReason(blocked)).toBe("no secrets")
    expect(hookBlockReason(new Error("request failed", { cause: { body: blocked } }))).toBe("no secrets")
  })

  test("ignores other errors", () => {
    expect(hookBlockReason(undefined)).toBeUndefined()
    expect(hookBlockReason("Prompt blocked by hook: x")).toBeUndefined()
    expect(
      hookBlockReason({ name: "MessageAbortedError", data: { message: "Prompt blocked by hook: x" } }),
    ).toBeUndefined()
  })
})
