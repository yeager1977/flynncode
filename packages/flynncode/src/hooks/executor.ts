import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Cause, Context, Effect, Fiber, Layer, Option, Schema, Semaphore } from "effect"
import { spawn } from "node:child_process"
import { buffer } from "node:stream/consumers"
import { ConfigHooksV1 } from "@flynncode/core/v1/config/hooks"
import { ConfigPermissionV1 } from "@flynncode/core/v1/config/permission"
import type { HooksRunner } from "@/hooks/runner"
import { HooksConfig } from "@/hooks/config"
import { HooksTrust } from "@/hooks/trust"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { HooksManaged } from "@/hooks/managed"
import { ClaudeFormat } from "@/hooks/claude-format"

// File-hook execution protocol (stdin JSON in, stdout JSON out). Each group
// speaks its `format`: native (below) or Claude Code's (last bullet).
// - exit 0 + JSON decision: PreToolUse/PermissionRequest honor
//   {"behavior":"deny","message"?} | {"behavior":"allow","updatedInput"?,"additionalContext"?} |
//   {"behavior":"ask","message"?,"updatedInput"?,"additionalContext"?} | {"behavior":"undecided","additionalContext"?}.
//   Merged deny > ask > allow > undecided; ask forces the permission prompt.
// - exit 2: deny (decision hooks) or blocked output (PostToolUse, PostToolUseFailure); the message
//   prefers a trimmed non-empty stderr, then stdout, else a generic fallback.
// - PostToolUse JSON may carry {"blockedOutput": string} to replace the model-visible result.
//   PostToolUseFailure stdin carries `error` and `isInterrupt` instead of `output`.
// - Observe hooks honor {"additionalContext"?,"systemMessage"?,"continue"?,"stopReason"?}.
//   On UserPromptSubmit, Stop and SubagentStop, exit 2 (stderr is the reason)
//   or {"behavior":"deny","message"?} blocks: the prompt is not admitted, or
//   the stop is refused and the reason continues the turn.
//   Non-JSON non-empty stdout on observe events is promoted wholesale to
//   additionalContext (Codex parity: plain stdout is developer context),
//   bounded by `additionalContextLimit`; valid-JSON output keeps the parsed
//   behavior and empty stdout stays a no-op.
// - Non-zero exit (other than 2), timeout, or unparseable output fails closed:
//   deny for decision hooks, warn-and-ignore for observe/post hooks.
// - Hook `timeout` is in seconds. Defaults: 600s for command hooks and 60s for
//   http and prompt hooks, except SessionEnd (1s default, 3s max). Trust is
//   checked before every spawn; untrusted hooks are skipped with a warning and
//   never executed (fail closed).
// - `format: "claude"` groups (see claude-format.ts) get Claude's stdin fields,
//   tool names and snake_case tool_input, the group's `env`, and a
//   `transcript_path` synced just before the spawn. Their matchers test the
//   Claude tool name. Exit 2 denies/blocks with stderr, exit 0 reads Claude's
//   JSON or plain-text context, and any other exit, a timeout or a spawn
//   failure is logged and ignored (never deny-on-error). `continue: false`
//   denies a tool call (or blocks its result) with `stopReason`. A PostToolUse
//   block keeps the tool's output and appends the reason on a marked line.
//   `systemMessage` on tool events is logged, as observe hooks' is.
// - `http` hooks POST the same input JSON a command would get on stdin, in the
//   group's format; a 2xx JSON body is read like "exit 0 + that stdout". A
//   non-2xx status, a timeout, a network error or a non-JSON body is logged
//   and ignored for EVERY format: unlike a failing native command, an
//   unreachable endpoint never denies. Header `$VAR`/`${VAR}` is filled only
//   for names in `allowedEnvVars`.
// - `prompt` hooks send the prompt (with `$ARGUMENTS` replaced by the input
//   JSON) to one model and expect {"ok":boolean,"reason"?}. ok:false denies a
//   tool decision hook, blocks UserPromptSubmit/Stop/SubagentStop and is only
//   logged elsewhere; ok:true, errors and invalid JSON express no opinion.

export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000
export const DEFAULT_REMOTE_TIMEOUT_MS = 60_000
export const SESSION_END_TIMEOUT_MS = 1_000
export const SESSION_END_TIMEOUT_MAX_MS = 3_000
export const ASYNC_CONCURRENCY = 8

export type DecisionEvent = "PreToolUse" | "PermissionRequest"
export type ObserveEvent =
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "PostCompact"
  | "UserPromptSubmit"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "Interrupt"
  | "Notification"
export type PostEvent = "PostToolUse" | "PostToolUseFailure"

export interface ExecutorInterface {
  readonly runDecision: (input: {
    event: DecisionEvent
    matchName: string
    tool: string
    sessionID: string
    callID: string
    args: Record<string, unknown>
    model?: string
    permissionMode?: string
    timeoutMaxMs?: number
  }) => Effect.Effect<HooksRunner.PreToolUseDecision, never, never>
  // PostToolUse (the default) reads `output`; PostToolUseFailure reads
  // `error` and `interrupted`.
  readonly runPostTool: (input: {
    event?: PostEvent
    tool: string
    matchName: string
    sessionID: string
    callID: string
    args: Record<string, unknown>
    output?: string
    error?: string
    interrupted?: boolean
    model?: string
    permissionMode?: string
    timeoutMaxMs?: number
  }) => Effect.Effect<HooksRunner.PostToolUseOutcome, never, never>
  readonly runObserve: (input: {
    event: ObserveEvent
    matchName: string
    sessionID: string
    payload: Record<string, unknown>
    timeoutMaxMs?: number
    defaultTimeoutMs?: number
  }) => Effect.Effect<HooksRunner.SessionObserve, never, never>
  readonly cancelSession: (sessionID: string) => Effect.Effect<void, never, never>
  // Whether any file hook group is configured for the event, from the loaded
  // config alone: nothing is matched, trusted or spawned.
  readonly hasHandlers: (event: ObserveEvent) => Effect.Effect<boolean, never, never>
}

export class Service extends Context.Service<Service, ExecutorInterface>()("@opencode/HooksExecutor") {}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

// Additive Codex-parity context for every hook JSON payload: model and
// permission_mode ride along only when the caller has them — unknown values
// are omitted entirely, never set to null or undefined (cwd is added at the
// payload build sites, which always have it).
function contextFields(input: { model?: string; permissionMode?: string }): Record<string, unknown> {
  return {
    ...(input.model !== undefined && { model: input.model }),
    ...(input.permissionMode !== undefined && { permission_mode: input.permissionMode }),
  }
}

export function resolveTimeoutMs(entryTimeoutSec: number | undefined, defaultMs: number, maxMs?: number) {
  const ms = entryTimeoutSec === undefined ? defaultMs : Math.max(0, entryTimeoutSec * 1000)
  if (maxMs === undefined) return ms
  return Math.min(ms, maxMs)
}

function eventGroups(hooks: ConfigHooksV1.Info | undefined, event: string) {
  // disableAllHooks is the kill-switch flag, not an event: only array values
  // on real event keys match.
  const value = hooks?.[event as keyof ConfigHooksV1.Info]
  return Array.isArray(value) ? value : []
}

// Native groups match the Flynncode name; Claude groups match `claudeName`.
function matchedHandlers(
  groups: Array<ConfigHooksV1.HookGroup>,
  event: string,
  matchName: string,
  claudeName: string | undefined,
) {
  return groups
    .filter((group) =>
      group.format === "claude"
        ? HooksConfig.matchesClaudeMatcher(claudeName, group.matcher)
        : HooksConfig.matchesMatcher(matchName, group.matcher),
    )
    .flatMap((group) =>
      group.hooks.map((handler) => ({
        def: HooksTrust.fromHandler(event, group.matcher, handler, group.source),
        handler,
        claude: group.format === "claude",
        env: group.env,
      })),
    )
}

// Every configured file hook with its trust identity and a display summary,
// for the trust browser (settings UI + config endpoints).
export function enumerateHooks(hooks: ConfigHooksV1.Info | undefined) {
  return Object.entries(hooks ?? {}).flatMap((entry) => {
    const event = entry[0]
    const groups = entry[1] as Array<ConfigHooksV1.HookGroup> | undefined
    // disableAllHooks is the kill-switch flag, not an event: skip non-array
    // values when walking the event table.
    if (!Array.isArray(groups)) return []
    return groups.flatMap((group) =>
      group.hooks.map((handler) => {
        const def = HooksTrust.fromHandler(event, group.matcher, handler, group.source)
        return {
          event,
          matcher: group.matcher ?? "",
          handler,
          def,
          summary: HooksConfig.summarize(handler),
          hash: HooksTrust.hashDef(def),
        }
      }),
    )
  })
}

type Collected = ClaudeFormat.Result

// Events with no Claude hook share this instead of a per-event cached sync.
const noTranscript = Effect.succeed("")

// "trusted" spawns; "killed" and "untrusted" are skipped, each with its own
// log wording.
type TrustVerdict = "trusted" | "untrusted" | "killed"

function decided(decision: HooksRunner.PreToolUseDecision): Collected {
  return { kind: "decision", decision }
}

function denyCollect(message: string): Collected {
  return { kind: "decision", decision: { behavior: "deny", message } }
}

function posted(blocked: boolean, reason?: string, additionalContext?: string): Collected {
  return { kind: "post", blocked, reason, additionalContext }
}

function observed(observe: HooksRunner.SessionObserve, block?: string): Collected {
  return block === undefined ? { kind: "observe", observe } : { kind: "observe", observe, block }
}

// Events a native observe hook can block, as Claude's can.
const BLOCKING_EVENTS = new Set(["UserPromptSubmit", "Stop", "SubagentStop"])

// A native `{"behavior":"deny"}` on a blocking event.
function deniedBy(event: string, stdout: string) {
  if (!BLOCKING_EVENTS.has(event)) return undefined
  const parsed = Option.getOrElse(decodeJson(stdout.trim()), () => undefined)
  if (!isRecord(parsed) || parsed["behavior"] !== "deny") return undefined
  return asString(parsed["message"]) || "Blocked by hook"
}

function failClosedCollect(kind: "decision" | "post" | "observe"): Collected {
  if (kind === "decision") return denyCollect("Hook failed")
  if (kind === "post") return posted(false)
  return observed({})
}

// No opinion: what an ignored http or prompt hook contributes.
function neutralCollect(kind: "decision" | "post" | "observe"): Collected {
  if (kind === "decision") return decided({ behavior: "undecided" })
  if (kind === "post") return posted(false)
  return observed({})
}

// `$VAR` and `${VAR}` become the variable's value only for allowed names;
// every other reference becomes "", so a hook file cannot read the environment.
function interpolateHeaders(headers: Record<string, string> | undefined, allowed: ReadonlyArray<string> | undefined) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map((entry) => [
      entry[0],
      entry[1].replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
        const name: string = braced ?? bare
        return allowed?.includes(name) ? (process.env[name] ?? "") : ""
      }),
    ]),
  )
}

const PROMPT_HOOK_SYSTEM =
  'You evaluate one condition for an automation hook. Reply with ONLY a JSON object, no prose and no code fences: {"ok": true} when the condition is met and the action should proceed, or {"ok": false, "reason": "<short reason>"} when it should not.'

// The first JSON object in a model reply, tolerating code fences and prose.
function readVerdict(text: string) {
  const trimmed = text.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  const parsed = Option.getOrElse(decodeJson(start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed), () => undefined)
  if (!isRecord(parsed) || typeof parsed["ok"] !== "boolean") return undefined
  return { ok: parsed["ok"], reason: asString(parsed["reason"])?.trim() || undefined }
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const trust = yield* HooksTrust.Service
      const flags = yield* RuntimeFlags.Service
      // Async hooks run detached, at most ASYNC_CONCURRENCY at a time per
      // session; sync hooks are awaited inline and never queue behind them.
      // A session's entry exists only while it has async hooks in flight.
      const running = new Map<string, { slots: Semaphore.Semaphore; fibers: Set<Fiber.Fiber<unknown, unknown>> }>()

      const sessionSlots = (sessionID: string) => {
        const existing = running.get(sessionID)
        if (existing) return existing
        const created = { slots: Semaphore.makeUnsafe(ASYNC_CONCURRENCY), fibers: new Set<Fiber.Fiber<unknown, unknown>>() }
        running.set(sessionID, created)
        return created
      }

      const track = (
        sessionID: string,
        entry: ReturnType<typeof sessionSlots>,
        fiber: Fiber.Fiber<unknown, unknown>,
      ) => {
        entry.fibers.add(fiber)
        if (!running.has(sessionID)) running.set(sessionID, entry)
        // Finished fibers leave the map so it never grows past live work.
        fiber.addObserver(() => {
          entry.fibers.delete(fiber)
          if (entry.fibers.size === 0 && running.get(sessionID) === entry) running.delete(sessionID)
        })
      }

      const cancelSession = Effect.fn("HooksExecutor.cancelSession")(function* (sessionID: string) {
        const entry = running.get(sessionID)
        if (!entry) return
        running.delete(sessionID)
        yield* Effect.forEach(
          Array.from(entry.fibers),
          (fiber) =>
            Effect.sync(() => fiber.pollUnsafe()).pipe(
              Effect.flatMap((done) => (done === undefined ? Fiber.interrupt(fiber) : Effect.void)),
            ),
          { discard: true },
        )
      })

      const workdir = Effect.gen(function* () {
        return yield* InstanceState.directory.pipe(Effect.catchCause(() => Effect.succeed(process.cwd())))
      })

      const trusted = Effect.fn("HooksExecutor.trusted")(function* (def: HooksTrust.HookDef) {
        // Kill switch first: hooks.disableAllHooks stops every file-config
        // hook unconditionally — managed (pre-trusted) hooks included — and
        // is intentionally orthogonal to the trust bypass flag, which can
        // never re-enable hooks while the kill switch is on. In-process
        // plugin hooks (the runner's plugin trigger edges) are unaffected;
        // gating them is a separate follow-up.
        const cfg = yield* config.get()
        if (cfg.hooks?.disableAllHooks === true) return "killed"
        const managed = yield* Effect.serviceOption(HooksManaged.ManagedHooks)
        if (Option.isSome(managed) && managed.value.isManaged(def)) return "trusted"
        if (flags.bypassHookTrust) return "trusted"
        // Trust is per project and covers referenced project scripts.
        const bound = yield* HooksTrust.bindToInstance(def)
        // Fail closed: trust lookup failures read as untrusted.
        const trusted = yield* trust.isTrusted(bound).pipe(Effect.orElseSucceed(() => false))
        return trusted ? "trusted" : "untrusted"
      })

      type Spawned = { code: number; stdout: string; stderr: string; timedOut: boolean }

      // node:child_process in its own process group so timeouts (and session
      // end) kill the whole tree: orphaned grandchildren would otherwise hold
      // the pipes open forever. Bun.spawn cannot express process groups, and
      // Process.spawn cannot take a writable stdin under Bun.
      const spawnCommand = (
        command: string,
        inputJson: string,
        timeoutMs: number,
        cwd: string,
        env?: Record<string, string>,
      ): Effect.Effect<Spawned, Error> => {
        let kill: ((signal: NodeJS.Signals) => void) | undefined
        return Effect.uninterruptibleMask((restore) =>
          restore(
            Effect.promise(async () => {
              const child = spawn("sh", ["-c", command], {
                cwd,
                env: { ...process.env, ...env },
                stdio: ["pipe", "pipe", "pipe"],
                detached: true,
                windowsHide: process.platform === "win32",
              })
              kill = (signal) => {
                try {
                  if (child.pid === undefined) return
                  if (process.platform === "win32") child.kill(signal)
                  else process.kill(-child.pid, signal)
                } catch {
                  return
                }
              }
              if (!child.stdin || !child.stdout || !child.stderr) {
                kill("SIGKILL")
                throw new Error("hook stdio not available")
              }
              child.stdin.on("error", () => undefined)
              try {
                child.stdin.write(inputJson)
              } catch {
                kill("SIGKILL")
                throw new Error("hook stdin write failed")
              }
              child.stdin.end()
              const read = (async () => {
                const [stdout, stderr, status] = await Promise.all([
                  buffer(child.stdout as NodeJS.ReadableStream).catch(() => Buffer.alloc(0)),
                  buffer(child.stderr as NodeJS.ReadableStream).catch(() => Buffer.alloc(0)),
                  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
                    child.on("error", () => resolve({ code: 1, signal: null }));
                    child.on("close", (code, signal) => resolve({ code, signal }));
                  }),
                ])
                return { stdout: stdout.toString(), stderr: stderr.toString(), code: status.code ?? 1 }
              })()
              let timedOut = false
              let killTimer: ReturnType<typeof setTimeout> | undefined
              const timer = setTimeout(() => {
                if (child.exitCode !== null || child.signalCode !== null) return
                timedOut = true
                kill?.("SIGTERM")
                killTimer = setTimeout(() => kill?.("SIGKILL"), 3000)
              }, timeoutMs)
              try {
                const result = await read
                return { ...result, timedOut }
              } finally {
                clearTimeout(timer)
                if (killTimer) clearTimeout(killTimer)
              }
            }),
          ).pipe(Effect.onInterrupt(() => Effect.sync(() => kill?.("SIGKILL"))))
        )
      }

      const callMcpTool = (
        server: string,
        tool: string,
        input: Record<string, unknown>,
        timeoutMs: number,
      ): Effect.Effect<string, Error> =>
        Effect.gen(function* () {
          const maybeMcp = yield* Effect.serviceOption(MCP.Service)
          if (Option.isNone(maybeMcp)) return yield* Effect.fail(new Error(`MCP unavailable for hook ${server}/${tool}`))
          const clients = yield* maybeMcp.value.clients()
          const client = clients[server]
          if (!client) return yield* Effect.fail(new Error(`MCP server not connected: ${server}`))
          const { CallToolResultSchema } = yield* Effect.promise(() => import("@modelcontextprotocol/sdk/types.js"))
          const result = yield* Effect.promise(() =>
            client.callTool({ name: tool, arguments: input }, CallToolResultSchema, { timeout: timeoutMs }),
          )
          if (result.isError) {
            return yield* Effect.fail(
              new Error(
                result.content
                  .flatMap((item) => (item.type === "text" ? [item.text] : []))
                  .filter((text) => text.trim())
                  .join("\n\n") || `MCP hook tool returned an error: ${server}/${tool}`,
              ),
            )
          }
          return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
        })

      const readDecisionJson = (stdout: string): HooksRunner.PreToolUseDecision | undefined => {
        const parsed = Option.getOrElse(decodeJson(stdout.trim()), () => undefined)
        if (!isRecord(parsed)) return undefined
        if (parsed["behavior"] === "deny") {
          return { behavior: "deny", message: asString(parsed["message"]) ?? "Denied by hook" }
        }
        if (parsed["behavior"] === "allow") {
          const updated = isRecord(parsed["updatedInput"]) ? parsed["updatedInput"] : undefined
          const context = asString(parsed["additionalContext"])
          if (updated) return { behavior: "allow", updatedInput: updated, additionalContext: context }
          if (context) return { behavior: "allow", additionalContext: context }
          return { behavior: "allow" }
        }
        if (parsed["behavior"] === "ask") {
          const message = asString(parsed["message"])
          const updated = isRecord(parsed["updatedInput"]) ? parsed["updatedInput"] : undefined
          const context = asString(parsed["additionalContext"])
          return {
            behavior: "ask",
            ...(message !== undefined && { message }),
            ...(updated && { updatedInput: updated }),
            ...(context && { additionalContext: context }),
          }
        }
        if (parsed["behavior"] === "undecided") {
          const context = asString(parsed["additionalContext"])
          return context ? { behavior: "undecided", additionalContext: context } : { behavior: "undecided" }
        }
        return undefined
      }

      const readObserveJson = (stdout: string): HooksRunner.SessionObserve | undefined => {
        const parsed = Option.getOrElse(decodeJson(stdout.trim()), () => undefined)
        if (!isRecord(parsed)) return undefined
        const out: HooksRunner.SessionObserve = {}
        const context = asString(parsed["additionalContext"])
        if (context) out.additionalContext = context
        const system = asString(parsed["systemMessage"])
        if (system) out.systemMessage = system
        if (typeof parsed["continue"] === "boolean") out.continue = parsed["continue"]
        const stop = asString(parsed["stopReason"])
        if (stop) out.stopReason = stop
        return out
      }

      const limitContext = (text: string | undefined, limit: number | undefined) => {
        if (text === undefined || limit === undefined) return text
        return text.slice(0, Math.max(0, limit))
      }

      // A native hook's successful output (exit 0 stdout, or a 2xx http body),
      // read by the event's kind. `strict` is the command rule: unparseable
      // decision output fails closed.
      const nativeOutput = (
        input: {
          kind: "decision" | "post" | "observe"
          event: string
          label: string
          limit: number | undefined
        },
        stdout: string,
        strict: boolean,
      ): Collected => {
        if (input.kind === "post") {
          const parsed = Option.getOrElse(decodeJson(stdout.trim()), () => undefined)
          if (isRecord(parsed) && typeof parsed["blockedOutput"] === "string") {
            return posted(true, parsed["blockedOutput"])
          }
          const context = isRecord(parsed) ? asString(parsed["additionalContext"]) : undefined
          return posted(false, undefined, limitContext(context, input.limit))
        }
        if (input.kind === "observe") {
          const observe = readObserveJson(stdout)
          if (observe) {
            if (observe.additionalContext) observe.additionalContext = limitContext(observe.additionalContext, input.limit)
            return observed(observe, deniedBy(input.event, stdout))
          }
          // Plain-text stdout on observe events is developer context (Codex
          // parity): only non-JSON output is promoted, so any valid-JSON
          // output keeps its previous parsed-or-empty behavior, and empty
          // output stays a no-op.
          const text = stdout.trim()
          const parsed = Option.getOrElse(decodeJson(text), () => undefined)
          return observed(parsed === undefined && text ? { additionalContext: limitContext(text, input.limit) } : {})
        }
        const decision = readDecisionJson(stdout)
        if (!decision) {
          // Empty output expresses no opinion; non-empty garbage fails closed
          // for a command, but an http hook never denies on a bad body.
          if (!strict || stdout.trim() === "") return decided({ behavior: "undecided" })
          return decided({ behavior: "deny", message: `Hook returned unparseable output: ${input.label}` })
        }
        if (decision.behavior === "allow" && decision.updatedInput === undefined && decision.additionalContext) {
          decision.additionalContext = limitContext(decision.additionalContext, input.limit)
        }
        if ((decision.behavior === "undecided" || decision.behavior === "ask") && decision.additionalContext) {
          decision.additionalContext = limitContext(decision.additionalContext, input.limit)
        }
        return decided(decision)
      }

      const collectCommand = Effect.fn("HooksExecutor.collectCommand")(function* (input: {
        kind: "decision" | "post" | "observe"
        event: string
        command: string
        payload: Record<string, unknown>
        timeoutMs: number
        cwd: string
        limit: number | undefined
      }) {
        const spawned = yield* spawnCommand(input.command, JSON.stringify(input.payload), input.timeoutMs, input.cwd)
        if (spawned.timedOut) {
          if (input.kind === "decision") {
            return decided({ behavior: "deny", message: `Hook timed out after ${input.timeoutMs}ms: ${input.command}` })
          }
          yield* Effect.logWarning("hook timed out", { command: input.command, timeoutMs: input.timeoutMs })
          if (input.kind === "post") return posted(false)
          return observed({})
        }
        if (spawned.code === 2) {
          const message =
            spawned.stderr.trim() || spawned.stdout.trim() || `Hook blocked: ${input.command}`
          if (input.kind === "decision") return decided({ behavior: "deny", message })
          if (input.kind === "post") return posted(true, message)
          if (BLOCKING_EVENTS.has(input.event)) return observed({}, message)
          yield* Effect.logWarning("hook exited blocking", { command: input.command })
          return observed({})
        }
        if (spawned.code !== 0) {
          const message = spawned.stderr.trim() || `Hook failed with code ${spawned.code}: ${input.command}`
          if (input.kind === "decision") return decided({ behavior: "deny", message })
          yield* Effect.logWarning("hook failed", { command: input.command, code: spawned.code })
          if (input.kind === "post") return posted(false)
          return observed({})
        }
        return nativeOutput({ ...input, label: input.command }, spawned.stdout, true)
      })

      // The input JSON a Claude-format hook gets: stdin for a command, the
      // body for http, and $ARGUMENTS for a prompt.
      const claudeInput = Effect.fn("HooksExecutor.claudeInput")(function* (input: {
        event: string
        payload: Record<string, unknown>
        toolName: string | undefined
        transcript: Effect.Effect<string>
        cwd: string
      }) {
        // Tool events carry the turn's approval mode; other events read the
        // same session policy the tool path resolves it from.
        const mode =
          asString(input.payload["permission_mode"]) ??
          ConfigPermissionV1.resolveSessionPolicy((yield* config.get()).permission ?? {}).approval
        return ClaudeFormat.input(input.event, input.payload, {
          transcriptPath: yield* input.transcript,
          permissionMode: ClaudeFormat.permissionMode(mode),
          cwd: input.cwd,
          toolName: input.toolName,
        })
      })

      // Claude's own rules (claude-format.ts): no outcome here ever fails the
      // call, so spawn failures read as a non-blocking error too.
      const collectClaude = Effect.fn("HooksExecutor.collectClaude")(function* (input: {
        event: string
        command: string
        payload: Record<string, unknown>
        toolName: string | undefined
        env: Record<string, string> | undefined
        transcript: Effect.Effect<string>
        timeoutMs: number
        cwd: string
        limit: number | undefined
      }) {
        const stdin = yield* claudeInput(input)
        const spawned = yield* spawnCommand(input.command, JSON.stringify(stdin), input.timeoutMs, input.cwd, input.env).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Claude hook failed to start", { command: input.command, error: error.message }).pipe(
              Effect.as(undefined),
            ),
          ),
        )
        if (spawned?.timedOut) yield* Effect.logWarning("hook timed out", { command: input.command, timeoutMs: input.timeoutMs })
        const exitCode = spawned === undefined || spawned.timedOut ? null : spawned.code
        if (exitCode !== null && exitCode !== 0 && exitCode !== 2) {
          yield* Effect.logWarning("Claude hook failed", { command: input.command, code: exitCode, stderr: spawned?.stderr })
        }
        const result = ClaudeFormat.output(input.event, {
          exitCode,
          stdout: spawned?.stdout ?? "",
          stderr: spawned?.stderr ?? "",
        })
        if (exitCode === 2 && result.kind === "observe" && result.block === undefined) {
          yield* Effect.logWarning("hook exited blocking", { command: input.command, stderr: spawned?.stderr })
        }
        return yield* claudeCollected({ ...input, label: input.command }, result)
      })

      // Claude's reading of an output (a command's or an http body's) into the
      // collected outcome of the event's kind.
      const claudeCollected = Effect.fn("HooksExecutor.claudeCollected")(function* (
        input: {
          event: string
          label: string
          payload: Record<string, unknown>
          limit: number | undefined
        },
        result: ClaudeFormat.Result,
      ) {
        // No tool-event surface shows a hook's systemMessage to the user, so
        // it is logged like an observe hook's (HooksContext.observe).
        if (result.kind !== "observe" && result.systemMessage) {
          yield* Effect.logWarning(`hooks.${input.event}`, { command: input.label, systemMessage: result.systemMessage })
        }
        if (result.kind === "post") {
          // Claude keeps the tool's output and shows the block reason beside
          // it; the runner hands `reason` to the model as the whole result.
          const output = asString(input.payload["output"])
          const reason =
            result.blocked && output ? `${output}\n\n[${input.event} hook blocked: ${result.reason}]` : result.reason
          return {
            kind: "post" as const,
            blocked: result.blocked,
            ...(result.stop && { stop: true }),
            ...(reason !== undefined && { reason }),
            ...(result.additionalContext !== undefined && {
              additionalContext: limitContext(result.additionalContext, input.limit),
            }),
          }
        }
        if (result.kind === "observe") {
          return result.observe.additionalContext === undefined
            ? result
            : {
                ...result,
                observe: { ...result.observe, additionalContext: limitContext(result.observe.additionalContext, input.limit) },
              }
        }
        const decision = result.decision
        const limited =
          decision.behavior !== "deny" && decision.additionalContext !== undefined
            ? { ...decision, additionalContext: limitContext(decision.additionalContext, input.limit) }
            : decision
        if ((limited.behavior !== "allow" && limited.behavior !== "ask") || limited.updatedInput === undefined) {
          return decided(limited)
        }
        const back = ClaudeFormat.fromClaudeArgs(asString(input.payload["tool"]) ?? "", limited.updatedInput)
        if (back.dropped.length > 0) {
          yield* Effect.logWarning("Claude hook updatedInput keys dropped", {
            command: input.label,
            tool: input.payload["tool"],
            dropped: back.dropped,
          })
        }
        return decided({ ...limited, updatedInput: back.args })
      })

      // The Claude name a tool event's Claude groups match on. MCP tool ids
      // (`<server>_<tool>`, sanitized) cannot be split reliably, so the
      // connected MCP clients say which server and tool an id belongs to.
      const claudeToolName = Effect.fn("HooksExecutor.claudeToolName")(function* (tool: string) {
        const name = ClaudeFormat.toolName(tool)
        if (name !== tool) return name
        const maybeMcp = yield* Effect.serviceOption(MCP.Service)
        if (Option.isNone(maybeMcp)) return tool
        const entry = (yield* maybeMcp.value.tools())[tool]
        if (!entry) return tool
        const server = Object.entries(yield* maybeMcp.value.clients()).find((item) => item[1] === entry.client)?.[0]
        return server === undefined ? tool : ClaudeFormat.mcpToolName(server, entry.def.name)
      })

      // Claude ignores matchers on UserPromptSubmit and Stop, matches
      // SessionEnd on its reason and Notification on its own type names.
      const claudeMatchName = Effect.fn("HooksExecutor.claudeMatchName")(function* (input: {
        event: string
        matchName: string
        payload: Record<string, unknown>
      }) {
        if (ClaudeFormat.isToolEvent(input.event)) return yield* claudeToolName(input.matchName)
        if (input.event === "UserPromptSubmit" || input.event === "Stop") return undefined
        if (input.event === "SessionEnd") return asString(input.payload["reason"]) ?? input.matchName
        if (input.event === "Notification") return ClaudeFormat.notificationType(input.matchName)
        return input.matchName
      })

      // Session.Service comes from the caller's context: the executor sits
      // below the session layer, and hooks fired outside a session get "".
      const transcriptPath = (sessionID: string) =>
        Effect.gen(function* () {
          if (!sessionID) return ""
          const { Session } = yield* Effect.promise(() => import("@/session/session"))
          const session = yield* Effect.serviceOption(Session.Service)
          if (Option.isNone(session)) return ""
          const { ClaudeTranscript } = yield* Effect.promise(() => import("@/hooks/claude-transcript"))
          return yield* ClaudeTranscript.sync({ sessionID, toolName: claudeToolName }).pipe(
            Effect.provideService(Session.Service, session.value),
          )
        })

      const collectMcp = Effect.fn("HooksExecutor.collectMcp")(function* (input: {
        kind: "decision" | "post" | "observe"
        event: string
        server: string
        tool: string
        template: Record<string, unknown> | undefined
        payload: Record<string, unknown>
        timeoutMs: number
        limit: number | undefined
      }) {
        const expanded = HooksConfig.expandMcpInput(input.template, {
          ...input.payload,
          tool_input: input.payload["args"] ?? {},
          tool_output: input.payload["output"],
        })
        const text = yield* callMcpTool(input.server, input.tool, expanded, input.timeoutMs).pipe(
          Effect.catch((error) =>
            input.kind === "decision"
              ? Effect.succeed(`__HOOK_MCP_FAILED__${error instanceof Error ? error.message : String(error)}`)
              : Effect.fail(error),
          ),
        )
        if (text.startsWith("__HOOK_MCP_FAILED__")) {
          return denyCollect(text.slice("__HOOK_MCP_FAILED__".length) || "MCP hook failed")
        }
        if (input.kind === "post") {
          const parsed = Option.getOrElse(decodeJson(text.trim()), () => undefined)
          if (isRecord(parsed) && typeof parsed["blockedOutput"] === "string") {
            return posted(true, parsed["blockedOutput"])
          }
          const context = isRecord(parsed) ? asString(parsed["additionalContext"]) : undefined
          return posted(false, undefined, limitContext(context, input.limit))
        }
        if (input.kind === "observe") {
          const observe = readObserveJson(text) ?? {}
          if (observe.additionalContext) observe.additionalContext = limitContext(observe.additionalContext, input.limit)
          return observed(observe, deniedBy(input.event, text))
        }
        const decision = readDecisionJson(text)
        if (!decision) {
          if (text.trim() === "") return decided({ behavior: "undecided" })
          return denyCollect(`MCP hook returned unparseable output: ${input.server}/${input.tool}`)
        }
        return decided(decision)
      })

      // The input JSON a hook handler is sent, in the group's format.
      const handlerInput = (
        entry: { claude: boolean },
        input: {
          event: string
          payload: Record<string, unknown>
          toolName: string | undefined
          transcript: Effect.Effect<string>
          cwd: string
        },
      ) => (entry.claude ? claudeInput(input) : Effect.succeed(input.payload))

      const collectHttp = Effect.fn("HooksExecutor.collectHttp")(function* (input: {
        kind: "decision" | "post" | "observe"
        event: string
        claude: boolean
        url: string
        headers: Record<string, string> | undefined
        allowedEnvVars: ReadonlyArray<string> | undefined
        payload: Record<string, unknown>
        toolName: string | undefined
        transcript: Effect.Effect<string>
        timeoutMs: number
        cwd: string
      }) {
        const body = JSON.stringify(yield* handlerInput(input, input))
        const response = yield* Effect.tryPromise({
          try: async (signal) => {
            const res = await fetch(input.url, {
              method: "POST",
              headers: { "content-type": "application/json", ...interpolateHeaders(input.headers, input.allowedEnvVars) },
              body,
              signal: AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]),
            })
            return { status: res.status, text: await res.text() }
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("http hook failed", { url: input.url, error: error.message }).pipe(Effect.as(undefined)),
          ),
        )
        // http failures are ignored for every format, native decision hooks
        // included: only a command's own failure fails closed.
        if (!response) return neutralCollect(input.kind)
        if (response.status < 200 || response.status >= 300) {
          yield* Effect.logWarning("http hook returned a non-2xx status", { url: input.url, status: response.status })
          return neutralCollect(input.kind)
        }
        const text = response.text.trim()
        if (text === "") return neutralCollect(input.kind)
        if (!isRecord(Option.getOrElse(decodeJson(text), () => undefined))) {
          yield* Effect.logWarning("http hook body is not a JSON object", { url: input.url })
          return neutralCollect(input.kind)
        }
        if (input.claude) {
          return yield* claudeCollected(
            { event: input.event, label: input.url, payload: input.payload, limit: undefined },
            ClaudeFormat.output(input.event, { exitCode: 0, stdout: text, stderr: "" }),
          )
        }
        return nativeOutput({ kind: input.kind, event: input.event, label: input.url, limit: undefined }, text, false)
      })

      // One non-streaming model request: the handler's model, else small_model,
      // else the session's model. Fails when no model or service is available.
      const askModel = Effect.fn("HooksExecutor.askModel")(function* (input: {
        sessionID: string
        model: string | undefined
        prompt: string
      }) {
        const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
        const { LLM } = yield* Effect.promise(() => import("@/session/llm"))
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        const { MessageID, SessionID } = yield* Effect.promise(() => import("@/session/schema"))
        const { LLMEvent } = yield* Effect.promise(() => import("@flynncode/llm"))
        const { Stream } = yield* Effect.promise(() => import("effect"))
        const maybeProvider = yield* Effect.serviceOption(Provider.Service)
        const maybeLLM = yield* Effect.serviceOption(LLM.Service)
        if (Option.isNone(maybeProvider) || Option.isNone(maybeLLM)) {
          return yield* Effect.fail(new Error("no model service available"))
        }
        const provider = maybeProvider.value
        const maybeSessions = yield* Effect.serviceOption(Session.Service)
        const session = Option.isSome(maybeSessions)
          ? yield* maybeSessions.value.get(SessionID.make(input.sessionID)).pipe(Effect.option)
          : Option.none()
        const anchor = Option.isSome(session) && session.value.model
          ? { providerID: session.value.model.providerID, modelID: session.value.model.id }
          : yield* provider.defaultModel().pipe(Effect.option, Effect.map(Option.getOrUndefined))
        const explicit = input.model
          ? yield* Effect.suspend(() => {
              const parsed = Provider.parseModel(input.model!)
              return provider.getModel(parsed.providerID, parsed.modelID)
            }).pipe(
              Effect.catch(() =>
                Effect.logWarning("prompt hook model not found, using the default", { model: input.model }).pipe(
                  Effect.as(undefined),
                ),
              ),
            )
          : undefined
        const small = explicit || !anchor ? undefined : yield* provider.getSmallModel(anchor.providerID)
        const resolved =
          explicit ??
          small ??
          (anchor
            ? yield* provider.getModel(anchor.providerID, anchor.modelID).pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined)
        if (!resolved) return yield* Effect.fail(new Error("no model available"))
        return yield* maybeLLM.value
          .stream({
            agent: {
              name: "hook",
              mode: "primary",
              native: true,
              hidden: true,
              options: {},
              temperature: 0,
              permission: [],
              prompt: PROMPT_HOOK_SYSTEM,
            },
            user: {
              id: MessageID.ascending(),
              sessionID: SessionID.make(input.sessionID),
              role: "user",
              agent: "hook",
              model: { providerID: resolved.providerID, modelID: resolved.id },
              time: { created: Date.now() },
            },
            system: [],
            small: true,
            tools: {},
            model: resolved,
            sessionID: input.sessionID,
            retries: 1,
            messages: [{ role: "user", content: input.prompt }],
          })
          .pipe(
            Stream.filter(LLMEvent.is.textDelta),
            Stream.map((event) => event.text),
            Stream.mkString,
          )
      })

      const collectPrompt = Effect.fn("HooksExecutor.collectPrompt")(function* (input: {
        kind: "decision" | "post" | "observe"
        event: string
        claude: boolean
        prompt: string
        model: string | undefined
        sessionID: string
        payload: Record<string, unknown>
        toolName: string | undefined
        transcript: Effect.Effect<string>
        timeoutMs: number
        cwd: string
      }) {
        const json = JSON.stringify(yield* handlerInput(input, input))
        const text = input.prompt.includes("$ARGUMENTS")
          ? input.prompt.replaceAll("$ARGUMENTS", () => json)
          : `${input.prompt}\n\n${json}`
        const reply = yield* askModel({ sessionID: input.sessionID, model: input.model, prompt: text }).pipe(
          Effect.timeout(input.timeoutMs),
          Effect.catchCause((cause) =>
            Effect.logWarning("prompt hook failed", { event: input.event, error: Cause.pretty(cause) }).pipe(
              Effect.as(undefined),
            ),
          ),
        )
        if (reply === undefined) return neutralCollect(input.kind)
        const verdict = readVerdict(reply)
        if (!verdict) {
          yield* Effect.logWarning("prompt hook reply is not {ok, reason}", { event: input.event })
          return neutralCollect(input.kind)
        }
        if (verdict.ok) return neutralCollect(input.kind)
        const reason = verdict.reason ?? "Blocked by prompt hook"
        if (input.kind === "decision") return denyCollect(reason)
        if (input.kind === "observe" && BLOCKING_EVENTS.has(input.event)) return observed({}, reason)
        yield* Effect.logWarning("prompt hook returned ok:false", { event: input.event, reason })
        return neutralCollect(input.kind)
      })

      const guardCollect = (
        single: Effect.Effect<Collected, Error>,
        kind: "decision" | "post" | "observe",
      ): Effect.Effect<Collected, never, never> =>
        single.pipe(
          Effect.catch((error) =>
            Effect.logWarning("hook execution failed", {
              error: error instanceof Error ? error.message : String(error),
            }).pipe(Effect.as(failClosedCollect(kind))),
          ),
        )

      const runHandlers = Effect.fn("HooksExecutor.runHandlers")(function* (input: {
        kind: "decision" | "post" | "observe"
        event: string
        matchName: string
        sessionID: string
        payload: Record<string, unknown>
        timeoutMaxMs?: number
        defaultTimeoutMs?: number
      }) {
        const cfg = yield* config.get()
        const cwd = yield* workdir
        const groups = eventGroups(cfg.hooks, input.event)
        const claudeName = groups.some((group) => group.format === "claude") ? yield* claudeMatchName(input) : undefined
        const entries = matchedHandlers(groups, input.event, input.matchName, claudeName)
        // The Claude tool name a Claude hook's stdin uses: the matched name on
        // tool events, the prompted tool on a permission Notification.
        const notifiedTool = input.event === "Notification" ? asString(input.payload["tool"]) : undefined
        const claudeTool =
          claudeName !== undefined && notifiedTool !== undefined ? yield* claudeToolName(notifiedTool) : claudeName
        // Synced at most once per event, and only when a Claude hook spawns.
        const transcript = entries.some((entry) => entry.claude)
          ? yield* Effect.cached(transcriptPath(input.sessionID))
          : noTranscript
        const collected: Collected[] = []
        for (const entry of entries) {
          const def = entry.def
          const handler = entry.handler
          const verdict = yield* trusted(def)
          if (verdict !== "trusted") {
            yield* Effect.logWarning(verdict === "killed" ? "hook skipped by hooks.disableAllHooks" : "skipping untrusted hook", {
              event: def.event,
              matcher: def.matcher,
              command: HooksConfig.summarize(handler),
            })
            continue
          }
          const timeoutMs = resolveTimeoutMs(
            handler.timeout,
            input.defaultTimeoutMs ??
              (handler.type === "http" || handler.type === "prompt" ? DEFAULT_REMOTE_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS),
            input.timeoutMaxMs,
          )
          if (entry.claude && handler.type === "mcp_tool") {
            yield* Effect.logWarning("skipping hook: Claude hooks have no mcp_tool handler", { event: def.event })
            continue
          }
          const limit = handler.type === "command" ? handler.additionalContextLimit : undefined
          const isAsync = handler.type === "command" && handler.async === true
          const collect =
            handler.type === "command"
              ? entry.claude
                ? collectClaude({
                    event: input.event,
                    command: handler.command,
                    payload: input.payload,
                    toolName: claudeTool,
                    env: entry.env,
                    transcript,
                    timeoutMs,
                    cwd,
                    limit,
                  })
                : collectCommand({
                    kind: input.kind,
                    event: input.event,
                    command: handler.command,
                    payload: input.payload,
                    timeoutMs,
                    cwd,
                    limit,
                  })
              : handler.type === "http"
                ? collectHttp({
                    kind: input.kind,
                    event: input.event,
                    claude: entry.claude,
                    url: handler.url,
                    headers: handler.headers,
                    allowedEnvVars: handler.allowedEnvVars,
                    payload: input.payload,
                    toolName: claudeTool,
                    transcript,
                    timeoutMs,
                    cwd,
                  })
                : handler.type === "prompt"
                  ? collectPrompt({
                      kind: input.kind,
                      event: input.event,
                      claude: entry.claude,
                      prompt: handler.prompt,
                      model: handler.model,
                      sessionID: input.sessionID,
                      payload: input.payload,
                      toolName: claudeTool,
                      transcript,
                      timeoutMs,
                      cwd,
                    })
                  : collectMcp({
                      kind: input.kind,
                      event: input.event,
                      server: handler.server,
                      tool: handler.tool,
                      template: handler.input,
                      payload: input.payload,
                      timeoutMs,
                      limit,
                    })
          if (isAsync) {
            const entry = sessionSlots(input.sessionID)
            const fiber = yield* Effect.forkDetach(
              entry.slots.withPermits(1)(guardCollect(collect, input.kind).pipe(Effect.ignore)),
            )
            track(input.sessionID, entry, fiber)
            continue
          }
          const outcome = yield* guardCollect(collect, input.kind)
          collected.push(outcome)
        }
        return collected
      })

      const isAllowRewrite = (
        decision: HooksRunner.PreToolUseDecision,
      ): decision is Extract<HooksRunner.PreToolUseDecision, { behavior: "allow" }> & {
        updatedInput: Record<string, unknown>
      } => decision.behavior === "allow" && decision.updatedInput !== undefined

      // deny > ask > allow > undecided.
      const mergeDecisions = (decisions: Array<HooksRunner.PreToolUseDecision>): HooksRunner.PreToolUseDecision => {
        const denials = decisions.filter((decision) => decision.behavior === "deny")
        const denied = denials[0]
        if (denied) return denials.some((decision) => decision.stop) ? { ...denied, stop: true } : denied
        const contexts = decisions.flatMap((decision) =>
          decision.behavior !== "deny" && decision.additionalContext ? [decision.additionalContext] : [],
        )
        const context = contexts.length > 0 ? contexts.join("\n\n") : undefined
        const asked = decisions.find((decision) => decision.behavior === "ask")
        const rewritten = decisions.find(isAllowRewrite)
        // An ask prompts for its own rewrite, else for another hook's.
        if (asked) {
          const updated = asked.updatedInput ?? rewritten?.updatedInput
          return {
            behavior: "ask",
            ...(asked.message !== undefined && { message: asked.message }),
            ...(updated !== undefined && { updatedInput: updated }),
            ...(context !== undefined && { additionalContext: context }),
          }
        }
        if (rewritten) {
          return context === undefined
            ? { behavior: "allow", updatedInput: rewritten.updatedInput }
            : { behavior: "allow", updatedInput: rewritten.updatedInput, additionalContext: context }
        }
        const allowed = decisions.find((decision) => decision.behavior === "allow")
        if (allowed) {
          return context === undefined ? { behavior: "allow" } : { behavior: "allow", additionalContext: context }
        }
        return context === undefined ? { behavior: "undecided" } : { behavior: "undecided", additionalContext: context }
      }

      const runDecision = Effect.fn("HooksExecutor.runDecision")(function* (input: {
        event: DecisionEvent
        matchName: string
        tool: string
        sessionID: string
        callID: string
        args: Record<string, unknown>
        model?: string
        permissionMode?: string
        timeoutMaxMs?: number
      }) {
        const cwd = yield* workdir
        const collected = yield* runHandlers({
          kind: "decision",
          event: input.event,
          matchName: input.matchName,
          sessionID: input.sessionID,
          payload: {
            event: input.event,
            sessionID: input.sessionID,
            tool: input.tool,
            callID: input.callID,
            args: input.args,
            cwd,
            ...contextFields(input),
          },
          timeoutMaxMs: input.timeoutMaxMs,
        })
        return mergeDecisions(collected.flatMap((item) => (item.kind === "decision" ? [item.decision] : [])))
      })

      const runPostTool = Effect.fn("HooksExecutor.runPostTool")(function* (input: {
        event?: PostEvent
        tool: string
        matchName: string
        sessionID: string
        callID: string
        args: Record<string, unknown>
        output?: string
        error?: string
        interrupted?: boolean
        model?: string
        permissionMode?: string
        timeoutMaxMs?: number
      }) {
        const cwd = yield* workdir
        const event = input.event ?? "PostToolUse"
        const collected = yield* runHandlers({
          kind: "post",
          event,
          matchName: input.matchName,
          sessionID: input.sessionID,
          payload: {
            event,
            sessionID: input.sessionID,
            tool: input.tool,
            callID: input.callID,
            args: input.args,
            ...(event === "PostToolUseFailure"
              ? { error: input.error ?? "", isInterrupt: input.interrupted === true }
              : { output: input.output ?? "" }),
            cwd,
            ...contextFields(input),
          },
          timeoutMaxMs: input.timeoutMaxMs,
        })
        const blocked = collected.flatMap((item) => (item.kind === "post" && item.blocked ? [item] : []))
        if (blocked[0]) {
          const reason = blocked[0].reason ?? "Blocked by hook"
          return blocked.some((item) => item.stop)
            ? { blocked: true as const, reason, stop: true }
            : { blocked: true as const, reason }
        }
        const contexts = collected.flatMap((item) =>
          item.kind === "post" && item.additionalContext ? [item.additionalContext] : [],
        )
        if (contexts.length > 0) return { blocked: false as const, additionalContext: contexts.join("\n\n") }
        return { blocked: false as const }
      })

      const runObserve = Effect.fn("HooksExecutor.runObserve")(function* (input: {
        event: ObserveEvent
        matchName: string
        sessionID: string
        payload: Record<string, unknown>
        timeoutMaxMs?: number
        defaultTimeoutMs?: number
      }) {
        // Observe events are session-scoped: only the instance directory is
        // available here, so model/permission_mode stay omitted.
        const cwd = yield* workdir
        const collected = yield* runHandlers({
          kind: "observe",
          event: input.event,
          matchName: input.matchName,
          sessionID: input.sessionID,
          payload: { event: input.event, sessionID: input.sessionID, cwd, ...input.payload },
          timeoutMaxMs: input.timeoutMaxMs,
          defaultTimeoutMs: input.defaultTimeoutMs,
        })
        const observes = collected.flatMap((item) => (item.kind === "observe" ? [item.observe] : []))
        const blocks = collected.flatMap((item) => (item.kind === "observe" && item.block !== undefined ? [item.block] : []))
        const contexts = observes.flatMap((item) => (item.additionalContext ? [item.additionalContext] : []))
        const system = observes.map((item) => item.systemMessage).find((part) => part !== undefined)
        const continued = observes.some((item) => item.continue === false) ? false : undefined
        const stop = observes.map((item) => item.stopReason).find((part) => part !== undefined)
        const out: HooksRunner.SessionObserve = {}
        if (contexts.length > 0) out.additionalContext = contexts.join("\n\n")
        if (system) out.systemMessage = system
        if (continued !== undefined) out.continue = continued
        if (stop) out.stopReason = stop
        if (blocks.length > 0) out.block = { reason: blocks.join("\n\n") }
        return out
      })

      const hasHandlers = Effect.fn("HooksExecutor.hasHandlers")(function* (event: ObserveEvent) {
        const cfg = yield* config.get()
        return cfg.hooks?.disableAllHooks !== true && eventGroups(cfg.hooks, event).length > 0
      })

      return Service.of({ runDecision, runPostTool, runObserve, cancelSession, hasHandlers })
    }),
  ),
  deps: [Config.node, HooksTrust.node, RuntimeFlags.node, HooksManaged.node],
})

export * as HooksExecutor from "./executor"
