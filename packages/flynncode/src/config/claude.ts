export * as ConfigClaude from "./claude"

import path from "path"
import { existsSync } from "fs"
import { readFile } from "fs/promises"
import { Exit, Option, Schema } from "effect"
import { Glob } from "@flynncode/core/util/glob"
import { Wildcard } from "@flynncode/core/util/wildcard"
import { ConfigAgentV1 } from "@flynncode/core/v1/config/agent"
import { ConfigCommandV1 } from "@flynncode/core/v1/config/command"
import { ConfigHooksV1 } from "@flynncode/core/v1/config/hooks"
import { ConfigV1 } from "@flynncode/core/v1/config/config"
import type { PermissionV1 } from "@flynncode/core/v1/permission"
import { HooksConfig } from "@/hooks/config"
import { isRecord } from "@/util/record"
import { configEntryNameFromPath } from "./entry-name"
import { ConfigMarkdown } from "./markdown"

// Claude Code tool names mapped onto Flynncode permission keys. Write and
// MultiEdit run under the `edit` permission, like the deprecated `tools` map;
// so does NotebookEdit, which `SCOPES` narrows to notebooks.
export const TOOLS: Record<string, string> = {
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
  NotebookEdit: "edit",
  AskUserQuestion: "question",
  CronCreate: "schedule",
  CronList: "schedule",
  CronDelete: "schedule",
  ScheduleWakeup: "schedule",
  EnterWorktree: "worktree",
  ExitWorktree: "worktree",
}

// Request patterns a listed Claude tool covers when it is narrower than its
// whole permission key.
const SCOPES: Record<string, string> = {
  NotebookEdit: "*.ipynb",
}

// Checks rather than tools: the listed tools ask them, so an agent's `tools`
// list never takes them away.
const ALWAYS_SCOPED = ["external_directory", "doom_loop"]

// Permission keys Flynncode's own tools and checks ask for: the built-in tool
// ids from ToolRegistry, the tools of Flynncode's internal plugins (preview,
// Ollama model router) and keys asked outside a tool. There is no static
// registry of them (tools register at runtime), so keep this list in step; a
// registry test checks the built-in tool ids against it.
// Flynncode names MCP tools `<server>_<tool>`, which can collide with these,
// e.g. `mcp__external__directory` -> `external_directory`.
export const BUILTIN_PERMISSIONS = new Set([
  ...Object.values(TOOLS),
  "apply_patch",
  "archive",
  "auth_status",
  "bash_output",
  "computer_use",
  "cron_create",
  "cron_delete",
  "cron_list",
  "doom_loop",
  "enter_plan_mode",
  "enter_worktree",
  "execute",
  "exit_plan_mode",
  "exit_worktree",
  "external_directory",
  "invalid",
  "kill_shell",
  "list",
  "list_mcp_resource_templates",
  "list_mcp_resources",
  "lsp",
  "memory",
  "message",
  "monitor",
  "multiedit",
  "notebook_edit",
  "plan_enter",
  "plan_exit",
  "rank_models",
  "read_mcp_resource",
  "route_task",
  "schedule_wakeup",
  "session_manage",
  "skill",
  "todoread",
  "verify_page",
  "workflow_tool_approval",
  "worktree_discard",
  "write",
])

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
    const modelInfo = model(data.model, file)
    // Permission precedence follows key order, which the decode only keeps
    // with `propertyOrder: "original"`.
    const decoded = Schema.decodeUnknownExit(ConfigAgentV1.Info)(
      {
        name,
        description: data.description.replaceAll("\\n", "\n"),
        prompt: md.content.trim(),
        mode: "subagent",
        ...modelInfo,
        ...(tools.scopes
          ? { permission: tools.permission, options: { ...modelInfo.options, claudeTools: tools.scopes } }
          : {}),
        ...color(data.color),
      },
      { propertyOrder: "original" },
    )
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
  if (item.startsWith("mcp__")) {
    const permission = mcpPermission(item)
    return permission ? { permission, pattern: "*", action: "allow" } : undefined
  }
  const match = item.match(/^(\w+)(?:\((.*)\))?$/)
  const permission = match && Object.hasOwn(TOOLS, match[1]) ? TOOLS[match[1]] : undefined
  if (!match || !permission) return undefined
  const specifier = match[2]?.trim()
  if (!specifier || specifier === "*")
    return { permission, pattern: Object.hasOwn(SCOPES, match[1]) ? SCOPES[match[1]] : "*", action: "allow" }
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

// A `tools` list only takes tools away: it comes from a repository, so it must
// never grant more than the defaults and the user's config. The result denies
// each built-in permission the list does not cover, and `scopes` names what
// the list does cover, so Agent can deny everything else (MCP and plugin tools
// included) while the listed tools keep their standing rules. Without a list
// the agent keeps the default permissions (all tools).
function toolPermissions(input: unknown, file: string) {
  if (input === undefined || input === null) return { permission: undefined, scopes: undefined, warnings: [] }
  const names = (Array.isArray(input) ? input : String(input).split(","))
    .map((item) => String(item).trim())
    .filter(Boolean)
  const listed = names.map((item) => ({
    item,
    permission: Object.hasOwn(TOOLS, item) ? TOOLS[item] : item.startsWith("mcp__") ? mcpPermission(item) : undefined,
    pattern: Object.hasOwn(SCOPES, item) ? SCOPES[item] : "*",
  }))
  const scopes = [
    ...ALWAYS_SCOPED.map((permission) => ({ permission, pattern: "*" })),
    ...listed.flatMap((entry) => (entry.permission ? [{ permission: entry.permission, pattern: entry.pattern }] : [])),
  ]
  const unknown = listed.filter((entry) => !entry.permission).map((entry) => entry.item)
  return {
    permission: Object.fromEntries(
      [...BUILTIN_PERMISSIONS]
        .filter((key) => !scopes.some((scope) => scope.permission === key))
        .toSorted()
        .map((key) => [key, "deny" as const]),
    ),
    scopes,
    warnings: unknown.length
      ? [`Claude agent ${file}: ignored unknown tools or MCP names of built-in permissions ${unknown.join(", ")}`]
      : [],
  }
}

// Claude names MCP tools `mcp__<server>__<tool>` (or `mcp__<server>` for the
// whole server); Flynncode registers them as `<server>_<tool>`. A name that is,
// or whose `<server>_*` covers, a built-in permission is undefined: granting it
// would grant that built-in instead.
function mcpPermission(item: string) {
  const [server, ...tool] = item.slice("mcp__".length).split("__")
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
  const permission = tool.length ? `${sanitize(server)}_${sanitize(tool.join("__"))}` : `${sanitize(server)}_*`
  if (BUILTIN_PERMISSIONS.values().some((key) => Wildcard.match(key, permission))) return undefined
  return permission
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

export type ClaudeHookSource = {
  id: string
  kind: "user" | "project" | "plugin"
  label: string
  root?: string
  events: Array<string>
  commands: Array<string>
  enabled: boolean
  warnings: Array<string>
}

type JsonFile = { file: string; value: unknown; warnings: Array<string> }

type HookCandidate = Pick<ClaudeHookSource, "id" | "kind" | "label" | "root" | "warnings"> & {
  env: Record<string, string>
  files: Array<JsonFile>
}

type LoadedGroup = { event: string; group: ConfigHooksV1.HookGroup }

const HOOK_EVENTS = new Set(Object.keys(ConfigHooksV1.Info.fields).filter((key) => key !== "disableAllHooks"))
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeHandler = Schema.decodeUnknownOption(ConfigHooksV1.HookHandler)
const decodeStatusLine = Schema.decodeUnknownOption(ConfigV1.StatusLine)

// Loads Claude Code hooks from `~/.claude/settings{,.local}.json`, the project
// `.claude/settings{,.local}.json` files and the `hooks/hooks.json` of every
// plugin enabled in `~/.claude/settings.json`. Groups are tagged with their
// source, `format: "claude"` and the env Claude gives them, with
// `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` (braced or not) expanded
// in commands. Sources in `disabled` are listed but contribute no hooks.
// Claude's own `disableAllHooks: true` skips every source when it is set in the
// user settings, and a project's sources when it is set in that project's.
// Bad files and entries are skipped with a warning; nothing here fails config
// loading. `notices` holds the unsupported-event warnings, which are
// debug-level material: they are also in `sources[].warnings`, not `warnings`.
export async function loadHooks(input: {
  home: string
  projectDirs: ReadonlyArray<string>
  projectRoot: string
  disabled: ReadonlySet<string>
}) {
  const claude = path.join(input.home, ".claude")
  const env = { CLAUDE_PROJECT_DIR: input.projectRoot }
  const settings = await readJson(path.join(claude, "settings.json"))
  const user = {
    id: "claude:user",
    kind: "user" as const,
    label: "Claude Code user settings",
    root: claude,
    env,
    files: [settings, await readJson(path.join(claude, "settings.local.json"))],
    warnings: [],
  }
  if (hooksDisabled(user.files))
    return { hooks: HooksConfig.mergeHooksConfigs(), sources: [], warnings: [], notices: [] }
  const plugins = await pluginCandidates(claude, settings.value, env, input.projectRoot)
  const projects = (
    await Promise.all(
      input.projectDirs
        .filter((dir) => dir !== claude)
        .map(async (dir) => ({
          id: `claude:project:${dir}`,
          kind: "project" as const,
          label: `Claude Code project settings (${dir})`,
          root: dir,
          env,
          files: await Promise.all(
            ["settings.json", "settings.local.json"].map((file) => readJson(path.join(dir, file))),
          ),
          warnings: [],
        })),
    )
  ).filter((candidate) => !hooksDisabled(candidate.files))
  // A source with neither hooks nor warnings (e.g. settings without hooks) is
  // not worth listing.
  const loaded = [user, ...projects, ...plugins.candidates]
    .map((candidate) => loadSource(candidate, input.disabled))
    .filter((item) => item.groups.length > 0 || item.source.warnings.length > 0)
  return {
    hooks: HooksConfig.mergeHooksConfigs(
      ...loaded
        .filter((item) => item.source.enabled)
        .flatMap((item) => item.groups.map((entry) => ({ [entry.event]: [entry.group] }))),
    ),
    sources: loaded.map((item) => item.source),
    warnings: [
      ...plugins.warnings,
      ...loaded.flatMap((item) => item.source.warnings.filter((warning) => !item.notices.includes(warning))),
    ],
    notices: loaded.flatMap((item) => item.notices),
  }
}

// Claude Code's `statusLine` from the settings files `loadHooks` reads: the
// user's, then each project `.claude` directory from the root down, with
// `settings.local.json` after `settings.json`. The last one set wins, as the
// closest settings win in Claude. It carries its file's source id
// (`claude:user` or `claude:project:<dir>`) so the trust check can gate it,
// and `$CLAUDE_PROJECT_DIR` is expanded as in hooks. Sources in `disabled` and
// sources whose `disableAllHooks` is on (which also turns Claude's status line
// off) are skipped. A shape other than a command is skipped with a warning;
// unreadable files already warn when hooks load.
export async function loadStatusLine(input: {
  home: string
  projectDirs: ReadonlyArray<string>
  projectRoot: string
  disabled: ReadonlySet<string>
}) {
  const claude = path.join(input.home, ".claude")
  const read = (dir: string) =>
    Promise.all(["settings.json", "settings.local.json"].map((file) => readJson(path.join(dir, file))))
  const user = { id: "claude:user", files: await read(claude) }
  if (hooksDisabled(user.files)) return { statusLine: undefined, warnings: [] }
  const projects = await Promise.all(
    input.projectDirs
      .filter((dir) => dir !== claude)
      .map(async (dir) => ({ id: `claude:project:${dir}`, files: await read(dir) })),
  )
  const parsed = [user, ...projects]
    .filter((source) => !input.disabled.has(source.id) && !hooksDisabled(source.files))
    .flatMap((source) =>
      source.files
        .filter((file) => isRecord(file.value) && file.value.statusLine !== undefined)
        .map((file) => ({
          id: source.id,
          file: file.file,
          line: decodeStatusLine(isRecord(file.value) ? file.value.statusLine : undefined),
        })),
    )
  const found = parsed.findLast((item) => Option.isSome(item.line))
  return {
    statusLine:
      found && Option.isSome(found.line)
        ? {
            type: "command" as const,
            command: expandCommand(found.line.value.command, { CLAUDE_PROJECT_DIR: input.projectRoot }),
            ...(found.line.value.padding === undefined ? {} : { padding: found.line.value.padding }),
            source: found.id,
          }
        : undefined,
    warnings: parsed
      .filter((item) => Option.isNone(item.line))
      .map((item) => `skipped Claude statusLine in ${item.file}: only { type: "command", command } is supported`),
  }
}

// Claude merges settings files, `settings.local.json` winning, and any
// `disableAllHooks: true` left in the result switches its hooks off.
function hooksDisabled(files: ReadonlyArray<JsonFile>) {
  return (
    files
      .map((file) => (isRecord(file.value) ? file.value.disableAllHooks : undefined))
      .filter((value) => typeof value === "boolean")
      .at(-1) === true
  )
}

// Plugins set to `true` in `enabledPlugins`, resolved through
// `installed_plugins.json` (version 2: name -> list of installs). The user
// install wins, else the project install whose `projectPath` is this project.
// A plugin without `hooks/hooks.json` has no hooks and is not a source.
async function pluginCandidates(claude: string, settings: unknown, env: Record<string, string>, projectRoot: string) {
  const enabled =
    isRecord(settings) && isRecord(settings.enabledPlugins)
      ? Object.entries(settings.enabledPlugins)
          .filter((entry) => entry[1] === true)
          .map((entry) => entry[0])
      : []
  if (enabled.length === 0) return { candidates: [], warnings: [] }
  const installed = await readJson(path.join(claude, "plugins", "installed_plugins.json"))
  // An invalid file already carries its own warning.
  if (installed.warnings.length > 0) return { candidates: [], warnings: installed.warnings }
  const unsupported = (reason: string) => ({
    candidates: [],
    warnings: [`skipped Claude plugin hooks: unsupported installed_plugins.json format (${reason}): ${installed.file}`],
  })
  if (installed.value === undefined) return unsupported("file is missing")
  if (!isRecord(installed.value) || installed.value.version !== 2 || !isRecord(installed.value.plugins)) {
    return unsupported("expected version 2 with a plugins object")
  }
  const plugins = installed.value.plugins
  const candidates = await Promise.all(
    enabled.map(async (name): Promise<HookCandidate | undefined> => {
      const listed = plugins[name]
      const entries = Array.isArray(listed) ? listed.filter(isRecord) : []
      const entry =
        entries.find((item) => item.scope === "user") ??
        entries.find((item) => item.scope === "project" && item.projectPath === projectRoot)
      const root = typeof entry?.installPath === "string" ? entry.installPath : undefined
      const base = {
        id: `claude:plugin:${name}`,
        kind: "plugin" as const,
        label: `Claude Code plugin ${name}`,
        root,
        env,
      }
      if (!entry) {
        const reason =
          entries.length === 0
            ? `not in ${installed.file}`
            : `no user-scope install and no project-scope install for ${projectRoot}`
        return { ...base, files: [], warnings: [`skipped Claude plugin ${name}: ${reason}`] }
      }
      if (!root) {
        return { ...base, files: [], warnings: [`skipped Claude plugin ${name}: install entry has no installPath`] }
      }
      if (!existsSync(root)) {
        return { ...base, files: [], warnings: [`skipped Claude plugin ${name}: install path ${root} is missing`] }
      }
      const hooks = path.join(root, "hooks", "hooks.json")
      if (!existsSync(hooks)) return undefined
      return {
        ...base,
        env: {
          ...env,
          CLAUDE_PLUGIN_ROOT: root,
          CLAUDE_PLUGIN_DATA: path.join(claude, "plugins", "data", name.replaceAll("@", "-")),
        },
        files: [await readJson(hooks)],
        warnings: [],
      }
    }),
  )
  return { candidates: candidates.filter((item) => item !== undefined), warnings: [] }
}

function loadSource(candidate: HookCandidate, disabled: ReadonlySet<string>) {
  const parsed = candidate.files.map((file) => parseHooks(file, candidate))
  const groups = parsed.flatMap((item) => item.groups)
  // One entry per unsupported event, however many of the source's files use it.
  const notices = [...new Set(parsed.flatMap((item) => item.unsupported))].map(
    (event) => `skipped Claude hook event ${event} in ${candidate.id}: not supported`,
  )
  const source: ClaudeHookSource = {
    id: candidate.id,
    kind: candidate.kind,
    label: candidate.label,
    root: candidate.root,
    events: [...new Set(groups.map((entry) => entry.event))],
    commands: groups.flatMap((entry) => entry.group.hooks.map(HooksConfig.summarize)),
    enabled: !disabled.has(candidate.id),
    warnings: [
      ...candidate.warnings,
      ...candidate.files.flatMap((file) => file.warnings),
      ...parsed.flatMap((item) => item.warnings),
      ...notices,
    ],
  }
  return { groups, source, notices }
}

function parseHooks(json: JsonFile, candidate: HookCandidate) {
  if (!isRecord(json.value) || json.value.hooks === undefined) return { groups: [], warnings: [], unsupported: [] }
  if (!isRecord(json.value.hooks)) {
    return {
      groups: [],
      warnings: [`skipped Claude hooks in ${json.file}: "hooks" is not an object`],
      unsupported: [],
    }
  }
  const events = Object.entries(json.value.hooks).map((entry) => {
    const event = entry[0]
    if (!HOOK_EVENTS.has(event)) return { groups: [], warnings: [], unsupported: [event] }
    if (!Array.isArray(entry[1])) {
      return {
        groups: [],
        warnings: [`skipped Claude hook event ${event} in ${json.file}: expected a list of groups`],
        unsupported: [],
      }
    }
    const parsed = entry[1].map((raw: unknown) => parseGroup(raw, `${json.file} (${event})`, candidate))
    return {
      groups: parsed.flatMap((item): Array<LoadedGroup> => (item.group ? [{ event, group: item.group }] : [])),
      warnings: parsed.flatMap((item) => item.warnings),
      unsupported: [],
    }
  })
  return {
    groups: events.flatMap((item) => item.groups),
    warnings: events.flatMap((item) => item.warnings),
    unsupported: events.flatMap((item) => item.unsupported),
  }
}

function parseGroup(raw: unknown, where: string, candidate: HookCandidate) {
  if (!isRecord(raw) || !Array.isArray(raw.hooks)) {
    return {
      group: undefined,
      warnings: [`skipped Claude hook group in ${where}: expected { matcher?, hooks: [...] }`],
    }
  }
  if (raw.matcher !== undefined && typeof raw.matcher !== "string") {
    return { group: undefined, warnings: [`skipped Claude hook group in ${where}: matcher must be a string`] }
  }
  const handlers = raw.hooks.map((item: unknown) => ({ item, decoded: decodeHandler(item) }))
  const hooks = handlers.flatMap((entry) =>
    Option.isSome(entry.decoded) ? [expandHandler(entry.decoded.value, candidate.env)] : [],
  )
  const warnings = handlers
    .filter((entry) => Option.isNone(entry.decoded))
    .map((entry) => {
      const type = isRecord(entry.item) && typeof entry.item.type === "string" ? entry.item.type : "unknown"
      return `skipped Claude hook in ${where}: unsupported or invalid "${type}" handler`
    })
  if (hooks.length === 0) return { group: undefined, warnings }
  const group: ConfigHooksV1.HookGroup = {
    ...(raw.matcher === undefined ? {} : { matcher: raw.matcher }),
    hooks,
    format: "claude",
    source: candidate.id,
    env: candidate.env,
  }
  return { group, warnings }
}

function expandHandler(handler: ConfigHooksV1.HookHandler, env: Record<string, string>) {
  if (handler.type !== "command") return handler
  return { ...handler, command: expandCommand(handler.command, env) }
}

function expandCommand(command: string, env: Record<string, string>) {
  // Whole names only: $CLAUDE_PROJECT_DIRX is some other variable.
  return command.replace(
    /\$(?:\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}|(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)(?![A-Za-z0-9_]))/g,
    (match, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? ""
      return Object.hasOwn(env, name) ? env[name] : match
    },
  )
}

// A missing file is no source; an unreadable or invalid one is a warning.
async function readJson(file: string): Promise<JsonFile> {
  if (!existsSync(file)) return { file, value: undefined, warnings: [] }
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return { file, value: undefined, warnings: [`skipped Claude settings ${file}: unreadable`] }
  const value = decodeJson(text)
  if (Option.isNone(value))
    return { file, value: undefined, warnings: [`skipped Claude settings ${file}: invalid JSON`] }
  return { file, value: value.value, warnings: [] }
}
