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
  cron_create: "CronCreate",
  cron_list: "CronList",
  cron_delete: "CronDelete",
  schedule_wakeup: "ScheduleWakeup",
}

// Parameter names of the translated tools, with the shape of nested objects
// (or arrays of them), so a hook's snake_case `updatedInput` maps back onto
// them. Nested keys need the table too: MultiEdit's edits are already
// snake_case here. Tests keep these in step with the tools' schemas.
type Shape = { readonly [key: string]: Shape | true }

const PARAMS: Record<string, Shape> = {
  read: { filePath: true, offset: true, limit: true },
  write: { content: true, filePath: true },
  edit: { filePath: true, oldString: true, newString: true, replaceAll: true },
  multiedit: { file_path: true, edits: { old_string: true, new_string: true, replace_all: true } },
  bash: { command: true, timeout: true, workdir: true, interactive: true, run_in_background: true },
  glob: { pattern: true, path: true },
  grep: { pattern: true, path: true, include: true },
  webfetch: { url: true, format: true, timeout: true },
  websearch: { query: true, numResults: true, livecrawl: true, type: true, contextMaxCharacters: true },
  todowrite: { todos: { content: true, status: true, priority: true } },
  task: {
    description: true,
    prompt: true,
    subagent_type: true,
    task_id: true,
    command: true,
    isolation: true,
    model: true,
    cleanup: true,
    background: true,
  },
  notebook_edit: { notebook_path: true, cell_id: true, new_source: true, cell_type: true, edit_mode: true },
  question: {
    questions: { question: true, header: true, options: { label: true, description: true }, multiple: true },
  },
  cron_create: { cron: true, prompt: true, recurring: true },
  cron_list: {},
  cron_delete: { id: true },
  schedule_wakeup: { delaySeconds: true, prompt: true, reason: true },
}

// Tools whose Claude Code input keeps camelCase keys (ScheduleWakeup's `delaySeconds`), passed to hooks unchanged.
const CAMEL = new Set(["schedule_wakeup"])

// Tools whose PostToolUse `tool_response` is `{ filePath, success: true }`,
// with the argument that names the file.
const FILE_TOOLS: Record<string, string> = {
  write: "filePath",
  edit: "filePath",
  multiedit: "file_path",
  notebook_edit: "notebook_path",
}

const MODES: Record<string, string> = {
  manual: "default",
  "accept-edits": "acceptEdits",
  auto: "auto",
}

// Claude's `notification_type` for each Flynncode one; others pass through.
const NOTIFICATION_TYPES: Record<string, string> = {
  idle: "idle_prompt",
  question: "elicitation_dialog",
}

const TOOL_EVENTS = new Set(["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"])
const DECISION_EVENTS = new Set(["PreToolUse", "PermissionRequest"])
const POST_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"])
// Events whose exit 2 or `decision: "block"` blocks; the session enforces it.
const BLOCKING_EVENTS = new Set(["UserPromptSubmit", "Stop", "SubagentStop"])
// Events where plain stdout is context.
const TEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"])

// The executor's per-handler result. `block` on an observe result is the
// reason a UserPromptSubmit, Stop or SubagentStop hook blocked with.
// `systemMessage` on tool events is for the user, never the model. `stop` on
// a post result is `continue: false`: the turn ends after this tool step.
export type Result =
  | { kind: "decision"; decision: HooksRunner.PreToolUseDecision; systemMessage?: string }
  | { kind: "post"; blocked: boolean; reason?: string; additionalContext?: string; systemMessage?: string; stop?: boolean }
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

export function notificationType(type: string) {
  return Object.hasOwn(NOTIFICATION_TYPES, type) ? NOTIFICATION_TYPES[type] : type
}

export function permissionMode(mode: string | undefined) {
  return mode !== undefined && Object.hasOwn(MODES, mode) ? MODES[mode] : "default"
}

// camelCase keys become snake_case at every depth: in nested plain objects
// and in arrays of them, except for CAMEL tools. Other values are passed on
// as they are.
export function toClaudeArgs(id: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(NAMES, id) || CAMEL.has(id)) return args
  return snakeKeys(args)
}

// Maps keys back through PARAMS at every depth. Dropped keys are reported
// by path, e.g. `edits[].bogus`.
export function fromClaudeArgs(id: string, args: Record<string, unknown>): { args: Record<string, unknown>; dropped: Array<string> } {
  if (!Object.hasOwn(PARAMS, id)) return { args, dropped: [] }
  return fromShape(PARAMS[id], args, "")
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
    const args = isRecord(payload["args"]) ? payload["args"] : {}
    return {
      tool_name: name ?? toolName(tool),
      tool_input: toClaudeArgs(tool, args),
      tool_use_id: asString(payload["callID"]) ?? "",
      ...(event === "PostToolUse" && { tool_response: toolResponse(tool, args, asString(payload["output"]) ?? "") }),
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
  if (event === "Notification") {
    const message = asString(payload["message"]) ?? ""
    const tool = asString(payload["tool"])
    // A permission prompt's message ends with the tool, renamed for Claude.
    return {
      message:
        tool !== undefined && name !== undefined && message.endsWith(tool)
          ? message.slice(0, message.length - tool.length) + name
          : message,
      notification_type: notificationType(asString(payload["notificationType"]) ?? ""),
    }
  }
  return {}
}

// PostToolUse `tool_response`, built from the model-visible output (Flynncode
// keeps no separate stdout/stderr):
// - Bash: `{ stdout, interrupted: false }`, stdout being the merged output.
// - Write, Edit, MultiEdit, NotebookEdit: `{ filePath, success: true }`.
// - anything else: `{ output }`.
function toolResponse(tool: string, args: Record<string, unknown>, output: string) {
  if (tool === "bash") return { stdout: output, interrupted: false }
  if (Object.hasOwn(FILE_TOOLS, tool)) return { filePath: args[FILE_TOOLS[tool]], success: true }
  return { output }
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
  const system = asString(parsed["systemMessage"]) || undefined
  const stop = asString(parsed["stopReason"]) || undefined
  // `continue: false` outranks any event-specific decision: the call is
  // denied, or its result blocked, with the stop reason, and the turn ends
  // after this tool step. A prompt is blocked; a stop is let through.
  const halted = parsed["continue"] === false ? (stop ?? "Stopped by hook") : undefined
  if (DECISION_EVENTS.has(event)) {
    return {
      kind: "decision",
      decision: halted ? { behavior: "deny", message: halted, stop: true } : readDecision(event, parsed, specific, context),
      ...(system && { systemMessage: system }),
    }
  }
  if (POST_EVENTS.has(event)) {
    if (halted) return { kind: "post", blocked: true, reason: halted, stop: true, ...(system && { systemMessage: system }) }
    const block = parsed["decision"] === "block" ? (reason ?? "Blocked by hook") : undefined
    if (block) return { kind: "post", blocked: true, reason: block, ...(system && { systemMessage: system }) }
    return { kind: "post", blocked: false, ...(context && { additionalContext: context }), ...(system && { systemMessage: system }) }
  }
  const observe: HooksRunner.SessionObserve = {
    ...(context && { additionalContext: context }),
    ...(system && { systemMessage: system }),
    ...(typeof parsed["continue"] === "boolean" && { continue: parsed["continue"] }),
    ...(stop && { stopReason: stop }),
  }
  if (event === "UserPromptSubmit" && halted) return { kind: "observe", observe, block: halted }
  if (BLOCKING_EVENTS.has(event) && !halted && parsed["decision"] === "block") {
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
): HooksRunner.PreToolUseDecision {
  const request = event === "PermissionRequest" && isRecord(specific["decision"]) ? specific["decision"] : undefined
  const legacy = parsed["decision"] === "approve" ? "allow" : parsed["decision"] === "block" ? "deny" : undefined
  const behavior = request ? request["behavior"] : (specific["permissionDecision"] ?? legacy)
  const message =
    (request ? asString(request["message"]) : asString(specific["permissionDecisionReason"]) || asString(parsed["reason"])) ||
    undefined
  const updated = request ? request["updatedInput"] : specific["updatedInput"]
  if (behavior === "deny") return { behavior: "deny", message: message ?? "Denied by hook" }
  if (behavior === "ask") {
    return {
      behavior: "ask",
      ...(message && { message }),
      ...(isRecord(updated) && { updatedInput: updated }),
      ...(context && { additionalContext: context }),
    }
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

// Only plain objects have their keys translated; class instances and other
// non-plain values pass through intact.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function snakeKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map((entry) => [
      entry[0].replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      snakeValue(entry[1]),
    ]),
  )
}

function snakeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeValue)
  return isPlainObject(value) ? snakeKeys(value) : value
}

function fromShape(shape: Shape, record: Record<string, unknown>, prefix: string) {
  const mapped = Object.entries(record).map((entry) => {
    const camel = entry[0].replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())
    const key = Object.hasOwn(shape, entry[0]) ? entry[0] : Object.hasOwn(shape, camel) ? camel : undefined
    if (key === undefined) return { entries: [], dropped: [prefix + entry[0]] }
    const inner = shape[key]
    if (inner === true) return { entries: [[key, entry[1]]], dropped: [] }
    const nested = fromNested(inner, entry[1], prefix + key)
    return { entries: [[key, nested.value]], dropped: nested.dropped }
  })
  return {
    args: Object.fromEntries(mapped.flatMap((item) => item.entries)),
    dropped: mapped.flatMap((item) => item.dropped),
  }
}

function fromNested(shape: Shape, value: unknown, path: string): { value: unknown; dropped: Array<string> } {
  if (Array.isArray(value)) {
    const items = value.map((item) => fromNested(shape, item, `${path}[]`))
    return { value: items.map((item) => item.value), dropped: [...new Set(items.flatMap((item) => item.dropped))] }
  }
  if (!isPlainObject(value)) return { value, dropped: [] }
  const out = fromShape(shape, value, `${path}.`)
  return { value: out.args, dropped: out.dropped }
}

export * as ClaudeFormat from "./claude-format"
