export * as ConfigClaude from "./claude"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@flynncode/core/util/glob"
import { ConfigAgentV1 } from "@flynncode/core/v1/config/agent"
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
    warnings.push(...tools.warnings, ...modelWarnings(data.model, file))
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

function modelWarnings(input: unknown, file: string) {
  if (typeof input !== "string" || !input.trim()) return []
  const value = input.trim()
  if (ALIASES.has(value) || value.includes("/")) return []
  return [`Claude agent ${file}: model "${value}" is not provider/model; using the session model`]
}

function color(input: unknown) {
  if (typeof input !== "string") return {}
  if (/^#[0-9a-fA-F]{6}$/.test(input)) return { color: input }
  const mapped = COLORS[input.trim().toLowerCase()]
  return mapped ? { color: mapped } : {}
}
