export * as ConfigClaude from "./claude"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@flynncode/core/util/glob"
import { ConfigAgentV1 } from "@flynncode/core/v1/config/agent"
import { ConfigCommandV1 } from "@flynncode/core/v1/config/command"
import type { PermissionV1 } from "@flynncode/core/v1/permission"
import { configEntryNameFromPath } from "./entry-name"
import { ConfigMarkdown } from "./markdown"

// Claude Code tool names mapped onto Flynncode permission keys. Write and
// MultiEdit run under the `edit` permission, like the deprecated `tools` map.
const TOOLS: Record<string, string> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "bash",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
  Task: "task",
  NotebookEdit: "notebook_edit",
  AskUserQuestion: "question",
}

const COLORS: Record<string, ConfigAgentV1.Info["color"]> = {
  red: "error",
  orange: "warning",
  yellow: "warning",
  green: "success",
  blue: "info",
  cyan: "info",
  purple: "accent",
  pink: "secondary",
}

const ALIASES = new Set(["opus", "sonnet", "haiku", "inherit"])

// Loads Claude Code subagents from `<dir>/agents/**/*.md`, where `dir` is a
// `.claude` directory. Malformed files are skipped and reported as warnings so
// a bad Claude file never fails config loading.
export async function loadAgents(dir: string) {
  const agents: Record<string, ConfigAgentV1.Info> = {}
  const warnings: string[] = []
  const files = await Glob.scan("agents/**/*.md", { cwd: dir, absolute: true, dot: true, symlink: true })
  for (const file of files.toSorted()) {
    const md = await ConfigMarkdown.parse(file).catch(() => undefined)
    if (!md) {
      warnings.push(`skipped Claude agent ${file}: invalid frontmatter`)
      continue
    }
    const data = md.data
    if (typeof data.description !== "string" || !data.description.trim()) {
      warnings.push(`skipped Claude agent ${file}: missing description`)
      continue
    }
    const name =
      typeof data.name === "string" && data.name.trim()
        ? data.name.trim()
        : configEntryNameFromPath(path.relative(dir, file), ["agents/"])
    const tools = toolPermissions(data.tools, file)
    warnings.push(...tools.warnings, ...modelWarnings(data.model, `Claude agent ${file}`))
    const decoded = Schema.decodeUnknownExit(ConfigAgentV1.Info)({
      name,
      description: data.description.replaceAll("\\n", "\n"),
      prompt: md.content.trim(),
      mode: "subagent",
      ...model(data.model, file),
      ...(tools.permission ? { permission: tools.permission } : {}),
      ...color(data.color),
    })
    if (Exit.isFailure(decoded)) {
      warnings.push(`skipped Claude agent ${file}: ${String(decoded.cause)}`)
      continue
    }
    agents[name] = decoded.value
  }
  return { agents, warnings }
}

// Loads Claude Code slash commands from `<dir>/commands/**/*.md`. Nested
// directories namespace the name (`git/pr.md` -> `git:pr`). Malformed files are
// skipped and reported as warnings. `allowed-tools` is carried verbatim: the
// runner interprets the Claude tool patterns when the command executes.
export async function loadCommands(dir: string) {
  const commands: Record<string, ConfigCommandV1.Info> = {}
  const warnings: string[] = []
  const files = await Glob.scan("commands/**/*.md", { cwd: dir, absolute: true, dot: true, symlink: true })
  for (const file of files.toSorted()) {
    const md = await ConfigMarkdown.parse(file).catch(() => undefined)
    if (!md) {
      warnings.push(`skipped Claude command ${file}: invalid frontmatter`)
      continue
    }
    const template = md.content.trim()
    // Unparseable YAML falls through as body text with the fence still in it.
    if (Object.keys(md.data).length === 0 && /^---\r?\n[\s\S]*?\r?\n---/.test(template)) {
      warnings.push(`skipped Claude command ${file}: invalid frontmatter`)
      continue
    }
    if (!template) {
      warnings.push(`skipped Claude command ${file}: empty body`)
      continue
    }
    const data = md.data
    const disableModelInvocation = booleanField(data["disable-model-invocation"])
    if (disableModelInvocation === "invalid") {
      warnings.push(`skipped Claude command ${file}: disable-model-invocation must be true or false`)
      continue
    }
    const hint = argumentHint(data["argument-hint"])
    const tools = commandTools(data["allowed-tools"])
    const modelInfo = model(data.model, file)
    warnings.push(...modelWarnings(data.model, `Claude command ${file}`))
    const decoded = Schema.decodeUnknownExit(ConfigCommandV1.Info)({
      template,
      ...(typeof data.description === "string" && data.description.trim()
        ? { description: data.description.trim() }
        : {}),
      ...(hint ? { argumentHint: hint } : {}),
      ...(tools ? { allowedTools: tools } : {}),
      ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
      ...(modelInfo.model ? { model: modelInfo.model } : {}),
      ...(modelInfo.options.claudeModel ? { claudeModel: modelInfo.options.claudeModel } : {}),
      claudeSource: file,
    })
    if (Exit.isFailure(decoded)) {
      warnings.push(`skipped Claude command ${file}: ${String(decoded.cause)}`)
      continue
    }
    commands[configEntryNameFromPath(path.relative(dir, file), ["commands/"]).replaceAll("/", ":")] = decoded.value
  }
  return { commands, warnings }
}

// Converts a Claude command's `allowed-tools` into allow rules for the turn
// that answers the command. `Bash(git add:*)` allows the `git add` prefix and
// `Bash(npm test)` that exact command. Other tools are granted whole; their
// specifiers have no Flynncode equivalent, so those entries are ignored.
export function allowedToolRules(tools: readonly string[]) {
  const converted = tools.map((item) => ({ item, rule: allowedToolRule(item.trim()) }))
  return {
    rules: converted.flatMap((entry) => (entry.rule ? [entry.rule] : [])),
    ignored: converted.filter((entry) => !entry.rule).map((entry) => entry.item),
  }
}

function allowedToolRule(item: string): PermissionV1.Rule | undefined {
  if (item.startsWith("mcp__")) return { permission: mcpPermission(item), pattern: "*", action: "allow" }
  const match = item.match(/^(\w+)(?:\((.*)\))?$/)
  const permission = match && Object.hasOwn(TOOLS, match[1]) ? TOOLS[match[1]] : undefined
  if (!match || !permission) return undefined
  const specifier = match[2]?.trim()
  if (!specifier || specifier === "*") return { permission, pattern: "*", action: "allow" }
  if (match[1] !== "Bash") return undefined
  return { permission, pattern: specifier.endsWith(":*") ? `${specifier.slice(0, -2)} *` : specifier, action: "allow" }
}

function booleanField(input: unknown) {
  if (input === undefined || input === null) return undefined
  if (typeof input === "boolean") return input
  if (input === "true") return true
  if (input === "false") return false
  return "invalid" as const
}

// YAML reads an unquoted `[message]` as a one-item list; show it back the way
// it was written.
function argumentHint(input: unknown) {
  if (typeof input === "string") return input.trim()
  if (Array.isArray(input)) return input.map((item) => `[${String(item)}]`).join(" ")
  return undefined
}

// Entries are comma separated, but a comma inside parentheses belongs to the
// tool pattern, e.g. `Bash(git add:*)`.
function commandTools(input: unknown) {
  if (input === undefined || input === null) return undefined
  if (Array.isArray(input)) return input.map((item) => String(item).trim()).filter(Boolean)
  return String(input)
    .split(/,(?![^()]*\))/)
    .map((item) => item.trim())
    .filter(Boolean)
}

// A `tools` list is an allowlist: everything else is denied. Without one the
// agent keeps the default permissions (all tools).
function toolPermissions(input: unknown, file: string) {
  if (input === undefined || input === null) return { permission: undefined, warnings: [] }
  const names = (Array.isArray(input) ? input : String(input).split(","))
    .map((item) => String(item).trim())
    .filter(Boolean)
  const unknown = names.filter((item) => !TOOLS[item] && !item.startsWith("mcp__"))
  const allowed = names.flatMap((item) => {
    if (TOOLS[item]) return [TOOLS[item]]
    if (item.startsWith("mcp__")) return [mcpPermission(item)]
    return []
  })
  return {
    // `*: deny` also covers external_directory; restore the default prompt so
    // allowed file tools can still ask to reach outside the project.
    permission: {
      "*": "deny" as const,
      external_directory: "ask" as const,
      ...Object.fromEntries(allowed.map((item) => [item, "allow" as const])),
    },
    warnings: unknown.length ? [`Claude agent ${file}: ignored unknown tools ${unknown.join(", ")}`] : [],
  }
}

// Claude names MCP tools `mcp__<server>__<tool>` (or `mcp__<server>` for the
// whole server); Flynncode registers them as `<server>_<tool>`.
function mcpPermission(item: string) {
  const [server, ...tool] = item.slice("mcp__".length).split("__")
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (!tool.length) return `${sanitize(server)}_*`
  return `${sanitize(server)}_${sanitize(tool.join("__"))}`
}

// `claudeSource` marks the entry as Claude-sourced for Agent, which strips it
// before options reach a provider. Agent uses it to keep built-in agents safe.
function model(input: unknown, file: string) {
  const value = typeof input === "string" ? input.trim() : ""
  if (ALIASES.has(value)) return { options: { claudeSource: file, claudeModel: value } }
  if (value.includes("/")) return { model: value, options: { claudeSource: file } }
  return { options: { claudeSource: file } }
}

function modelWarnings(input: unknown, label: string) {
  if (typeof input !== "string" || !input.trim()) return []
  const value = input.trim()
  if (ALIASES.has(value) || value.includes("/")) return []
  return [`${label}: model "${value}" is not provider/model; using the session model`]
}

function color(input: unknown) {
  if (typeof input !== "string") return {}
  if (/^#[0-9a-fA-F]{6}$/.test(input)) return { color: input }
  const mapped = COLORS[input.trim().toLowerCase()]
  return mapped ? { color: mapped } : {}
}
