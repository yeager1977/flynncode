import { Option, Schema } from "effect"
import type { HooksRunner } from "@/hooks/runner"
import { isRecord } from "@/util/record"

// Claude Code's hook protocol, for groups the Claude loader tags
// `format: "claude"`: what such a hook reads on stdin, and how its exit code
// and stdout read back into the executor's results.

// Flynncode tool id -> Claude Code tool name. This is the tool-id view of the
// compat pack's TOOLS map (Claude name -> permission key), which folds Write,
// MultiEdit and NotebookEdit into the `edit` permission although each is its
// own tool here.
const NAMES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  task: "Task",
  notebook_edit: "NotebookEdit",
  question: "AskUserQuestion",
}

// Parameter names of the translated tools, so a hook's snake_case
// `updatedInput` maps back onto them. A test keeps these in step with the
// tools' schemas.
const PARAMS: Record<string, ReadonlyArray<string>> = {
  read: ["filePath", "offset", "limit"],
  write: ["content", "filePath"],
  edit: ["filePath", "oldString", "newString", "replaceAll"],
  multiedit: ["file_path", "edits"],
  bash: ["command", "timeout", "workdir", "interactive", "run_in_background"],
  glob: ["pattern", "path"],
  grep: ["pattern", "path", "include"],
  webfetch: ["url", "format", "timeout"],
  websearch: ["query", "numResults", "livecrawl", "type", "contextMaxCharacters"],
  todowrite: ["todos"],
  task: ["description", "prompt", "subagent_type", "task_id", "command", "isolation", "model", "cleanup", "background"],
  notebook_edit: ["notebook_path", "cell_id", "new_source", "cell_type", "edit_mode"],
  question: ["questions"],
}

const MODES: Record<string, string> = {
  manual: "default",
  "accept-edits": "acceptEdits",
  auto: "auto",
}

const TOOL_EVENTS = new Set(["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"])
const DECISION_EVENTS = new Set(["PreToolUse", "PermissionRequest"])
const POST_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"])
// Events whose exit 2 or `decision: "block"` blocks; the session enforces it.
const BLOCKING_EVENTS = new Set(["UserPromptSubmit", "Stop", "SubagentStop"])
// Events where plain stdout is context.
const TEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"])

// HooksRunner.PreToolUseDecision has no `ask` yet; the executor folds it into
// `undecided` until the runner can force a permission prompt.
export type Ask = { behavior: "ask"; message?: string; additionalContext?: string }
export type Decision = HooksRunner.PreToolUseDecision | Ask

// The executor's per-handler result. `block` on an observe result is the
// reason a UserPromptSubmit, Stop or SubagentStop hook blocked with.
export type Result =
  | { kind: "decision"; decision: Decision }
  | { kind: "post"; blocked: boolean; reason?: string; additionalContext?: string }
  | { kind: "observe"; observe: HooksRunner.SessionObserve; block?: string }

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function isToolEvent(event: string) {
  return TOOL_EVENTS.has(event)
}

export function toolName(id: string) {
  return Object.hasOwn(NAMES, id) ? NAMES[id] : id
}

export function mcpToolName(server: string, tool: string) {
  return `mcp__${server}__${tool}`
}

export function permissionMode(mode: string | undefined) {
  return mode !== undefined && Object.hasOwn(MODES, mode) ? MODES[mode] : "default"
}

export function toClaudeArgs(id: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(NAMES, id)) return args
  return Object.fromEntries(
    Object.entries(args).map((entry) => [entry[0].replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), entry[1]]),
  )
}

export function fromClaudeArgs(id: string, args: Record<string, unknown>) {
  if (!Object.hasOwn(PARAMS, id)) return { args, dropped: [] as Array<string> }
  const known = PARAMS[id]
  const mapped = Object.entries(args).map((entry) => {
    const camel = entry[0].replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())
    const key = known.includes(entry[0]) ? entry[0] : known.includes(camel) ? camel : undefined
    return { from: entry[0], key, value: entry[1] }
  })
  return {
    args: Object.fromEntries(mapped.flatMap((item) => (item.key === undefined ? [] : [[item.key, item.value]]))),
    dropped: mapped.flatMap((item) => (item.key === undefined ? [item.from] : [])),
  }
}

// Builds a Claude hook's stdin from the executor's native payload. `toolName`
// overrides the translated tool name (MCP tools, whose server the payload
// does not carry).
export function input(
  event: string,
  payload: Record<string, unknown>,
  extra: { transcriptPath: string; permissionMode: string; cwd: string; toolName?: string },
): Record<string, unknown> {
  return {
    session_id: asString(payload["sessionID"]) ?? "",
    transcript_path: extra.transcriptPath,
    cwd: extra.cwd,
    permission_mode: extra.permissionMode,
    hook_event_name: event,
    ...eventFields(event, payload, extra.toolName),
  }
}

// Reads a Claude hook's exit code and output. `exitCode` is null for a
// timeout or a failure to start. Only exit 2 and exit 0 mean anything; every
// other outcome is Claude's non-blocking error.
export function output(event: string, result: { exitCode: number | null; stdout: string; stderr: string }): Result {
  if (result.exitCode === 2) return blocked(event, result.stderr.trim() || "Blocked by hook")
  if (result.exitCode !== 0) return neutral(event)
  const text = result.stdout.trim()
  const parsed = Option.getOrUndefined(decodeJson(text))
  if (isRecord(parsed)) return fromJson(event, parsed)
  if (text && TEXT_EVENTS.has(event)) return { kind: "observe", observe: { additionalContext: text } }
  return neutral(event)
}

function eventFields(event: string, payload: Record<string, unknown>, name: string | undefined): Record<string, unknown> {
  if (TOOL_EVENTS.has(event)) {
    const tool = asString(payload["tool"]) ?? ""
    return {
      tool_name: name ?? toolName(tool),
      tool_input: toClaudeArgs(tool, isRecord(payload["args"]) ? payload["args"] : {}),
      tool_use_id: asString(payload["callID"]) ?? "",
      ...(event === "PostToolUse" && { tool_response: payload["output"] }),
      ...(event === "PostToolUseFailure" && { error: payload["error"], is_interrupt: payload["isInterrupt"] === true }),
    }
  }
  if (event === "UserPromptSubmit") return { prompt: payload["prompt"] }
  if (event === "SessionStart") return { source: payload["source"] }
  if (event === "SessionEnd") return { reason: payload["reason"] }
  if (event === "PreCompact") return { trigger: payload["trigger"], custom_instructions: payload["customInstructions"] ?? "" }
  if (event === "Stop") return { stop_hook_active: payload["stopHookActive"] === true }
  if (event === "SubagentStart") return { agent_id: payload["agentID"], agent_type: payload["agentType"] }
  if (event === "SubagentStop") {
    return {
      stop_hook_active: payload["stopHookActive"] === true,
      agent_id: payload["agentID"],
      agent_type: payload["agentType"],
    }
  }
  if (event === "Notification") return { message: payload["message"], notification_type: payload["notificationType"] }
  return {}
}

function neutral(event: string): Result {
  if (DECISION_EVENTS.has(event)) return { kind: "decision", decision: { behavior: "undecided" } }
  if (POST_EVENTS.has(event)) return { kind: "post", blocked: false }
  return { kind: "observe", observe: {} }
}

function blocked(event: string, reason: string): Result {
  if (DECISION_EVENTS.has(event)) return { kind: "decision", decision: { behavior: "deny", message: reason } }
  if (POST_EVENTS.has(event)) return { kind: "post", blocked: true, reason }
  if (BLOCKING_EVENTS.has(event)) return { kind: "observe", observe: {}, block: reason }
  return { kind: "observe", observe: {} }
}

function fromJson(event: string, parsed: Record<string, unknown>): Result {
  const specific = isRecord(parsed["hookSpecificOutput"]) ? parsed["hookSpecificOutput"] : {}
  const context = asString(specific["additionalContext"]) || undefined
  const reason = asString(parsed["reason"]) || undefined
  if (DECISION_EVENTS.has(event)) return { kind: "decision", decision: readDecision(event, parsed, specific, context) }
  if (POST_EVENTS.has(event)) {
    if (parsed["decision"] === "block") return { kind: "post", blocked: true, reason: reason ?? "Blocked by hook" }
    return { kind: "post", blocked: false, ...(context && { additionalContext: context }) }
  }
  const system = asString(parsed["systemMessage"]) || undefined
  const stop = asString(parsed["stopReason"]) || undefined
  const observe: HooksRunner.SessionObserve = {
    ...(context && { additionalContext: context }),
    ...(system && { systemMessage: system }),
    ...(typeof parsed["continue"] === "boolean" && { continue: parsed["continue"] }),
    ...(stop && { stopReason: stop }),
  }
  if (BLOCKING_EVENTS.has(event) && parsed["decision"] === "block") {
    return { kind: "observe", observe, block: reason ?? "Blocked by hook" }
  }
  return { kind: "observe", observe }
}

// PreToolUse answers with `permissionDecision` (or the older top-level
// `decision: "approve" | "block"`); PermissionRequest answers with
// `hookSpecificOutput.decision.behavior`.
function readDecision(
  event: string,
  parsed: Record<string, unknown>,
  specific: Record<string, unknown>,
  context: string | undefined,
): Decision {
  const request = event === "PermissionRequest" && isRecord(specific["decision"]) ? specific["decision"] : undefined
  const legacy = parsed["decision"] === "approve" ? "allow" : parsed["decision"] === "block" ? "deny" : undefined
  const behavior = request ? request["behavior"] : (specific["permissionDecision"] ?? legacy)
  const message =
    (request ? asString(request["message"]) : asString(specific["permissionDecisionReason"]) || asString(parsed["reason"])) ||
    undefined
  const updated = request ? request["updatedInput"] : specific["updatedInput"]
  if (behavior === "deny") return { behavior: "deny", message: message ?? "Denied by hook" }
  if (behavior === "ask") {
    return { behavior: "ask", ...(message && { message }), ...(context && { additionalContext: context }) }
  }
  if (behavior === "allow") {
    return {
      behavior: "allow",
      ...(isRecord(updated) && { updatedInput: updated }),
      ...(context && { additionalContext: context }),
    }
  }
  return context ? { behavior: "undecided", additionalContext: context } : { behavior: "undecided" }
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export * as ClaudeFormat from "./claude-format"
