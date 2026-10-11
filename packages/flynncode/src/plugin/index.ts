import { LayerNode } from "@flynncode/core/effect/layer-node"
import type {
  Hooks,
  PermissionAskInput,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@flynncode/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@flynncode/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { AnthropicSubscriptionPlugin } from "./anthropic/subscription"
import { Session } from "@/session/session"
import { NamedError } from "@flynncode/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { ModalPlugin } from "./modal/modal"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { CerebrasPlugin } from "./cerebras"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { OllamaModelRouterPlugin } from "./ollama-model-router"
import { PreviewPlugin } from "./preview"
import { RoutinesPlugin } from "./routines"
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { clearPluginTools, syncPluginTools } from "./v2-tools"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@flynncode/core/installation/version"

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly triggerDecision: (
    input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
    output: { decision: "allow" | "deny" | "undecided"; message?: string; updatedInput?: Record<string, unknown> },
  ) => Effect.Effect<{ decision: "allow" | "deny" | "undecided"; message?: string; updatedInput?: Record<string, unknown> }>
  readonly triggerPermissionAsk: (
    input: {
      permission: string
      patterns: ReadonlyArray<string>
      sessionID: string
      metadata: Record<string, unknown>
      tool?: string
      args?: Record<string, unknown>
      id?: string
      callID?: string
      messageID?: string
    },
    output: { status: "ask" | "deny" | "allow" },
  ) => Effect.Effect<{ status: "ask" | "deny" | "allow" }>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
      }),
    AnthropicSubscriptionPlugin,
    CopilotAuthPlugin,
    ModalPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    SnowflakeCortexAuthPlugin,
    XaiAuthPlugin,
    CerebrasPlugin,
    OllamaModelRouterPlugin,
    PreviewPlugin,
    RoutinesPlugin,
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (init._tag === "Some") hooks.push(init.value)
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.catch(() => {
              // TODO: make proper events for this
              // events.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        syncPluginTools(hooks, ctx.directory, ctx.worktree)
        yield* Effect.addFinalizer(() => Effect.sync(() => clearPluginTools(ctx.directory)))

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const triggerDecision = Effect.fn("Plugin.triggerDecision")(function* (
      input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
      output: { decision: "allow" | "deny" | "undecided"; message?: string; updatedInput?: Record<string, unknown> },
    ) {
      const s = yield* InstanceState.get(state)
      // Aggregate across decision sources with isolated per-hook outputs:
      // any deny wins (first deny short-circuits), allows merge updatedInput
      // left-to-right, undecided hooks change nothing.
      const mergedUpdated: Record<string, unknown> = {}
      let sawRewrite = false
      for (const hook of s.hooks) {
        const fn = hook["tool.permission"]
        if (!fn) continue
        const perHook: {
          decision: "allow" | "deny" | "undecided"
          message?: string
          updatedInput?: Record<string, unknown>
        } = { decision: "undecided" }
        yield* Effect.promise(async () => fn(input, perHook))
        // Fail closed: first deny short-circuits, never silently continue.
        if (perHook.decision === "deny") {
          output.decision = "deny"
          output.message = perHook.message
          return output
        }
        if (perHook.decision !== "allow") continue
        output.decision = "allow"
        if (perHook.updatedInput) {
          sawRewrite = true
          Object.assign(mergedUpdated, perHook.updatedInput)
        }
      }
      if (sawRewrite) output.updatedInput = mergedUpdated
      return output
    })

    const triggerPermissionAsk = Effect.fn("Plugin.triggerPermissionAsk")(function* (
      input: {
        permission: string
        patterns: ReadonlyArray<string>
        sessionID: string
        metadata: Record<string, unknown>
        tool?: string
        args?: Record<string, unknown>
        id?: string
        callID?: string
        messageID?: string
      },
      output: { status: "ask" | "deny" | "allow" },
    ) {
      const s = yield* InstanceState.get(state)
      // The hook payload reuses the response-shaped Permission object for the
      // fields the ask path can fill honestly: the tool name stands in for the
      // title and time.created is the current wall clock. Everything the ask
      // cannot fill is an omitted key, never a sentinel placeholder.
      const payload: PermissionAskInput = {
        type: input.permission,
        pattern: input.patterns.length === 1 ? input.patterns[0] : [...input.patterns],
        sessionID: input.sessionID,
        title: input.tool ?? input.permission,
        metadata: input.metadata,
        time: { created: Date.now() },
        permission: input.permission,
        patterns: [...input.patterns],
      }
      if (input.id !== undefined) payload.id = input.id
      if (input.messageID !== undefined) payload.messageID = input.messageID
      if (input.callID !== undefined) payload.callID = input.callID
      if (input.tool !== undefined) payload.tool = input.tool
      if (input.args !== undefined) payload.args = input.args
      // Intentional parity with tool.permission aggregation: isolated
      // per-hook outputs, any deny short-circuits, allow is sticky, and
      // ask/no-op changes nothing.
      for (const hook of s.hooks) {
        const fn = hook["permission.ask"]
        if (!fn) continue
        const perHook: { status: "ask" | "deny" | "allow" } = { status: "ask" }
        const ran = yield* Effect.tryPromise({
          // The async wrapper is load-bearing: hooks may return undefined
          // while mutating the isolated output synchronously, which a bare
          // tryPromise would treat as a fault (non-thenable .then).
          try: async () => fn(payload, perHook),
          catch: errorMessage,
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("plugin permission.ask hook failed; falling through to the prompt", { error }),
          ),
          Effect.option,
        )
        // Fail open: a throwing plugin hook cannot deny by crashing — its
        // isolated decision is discarded and the ask continues to the next
        // hook or the normal prompt.
        if (ran._tag === "None") continue
        if (perHook.status === "deny") {
          output.status = "deny"
          return output
        }
        if (perHook.status !== "allow") continue
        output.status = "allow"
      }
      return output
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, triggerDecision, triggerPermissionAsk, list, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, RuntimeFlags.node],
})

export * as Plugin from "."
