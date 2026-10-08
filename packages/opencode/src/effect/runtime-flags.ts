import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("OPENCODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  autoShare: bool("OPENCODE_AUTO_SHARE"),
  pure: bool("OPENCODE_PURE"),
  disableDefaultPlugins: bool("OPENCODE_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("OPENCODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("OPENCODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("OPENCODE_DISABLE_LSP_DOWNLOAD"),
  // One-invocation escape hatch: run file hooks without persisted trust.
  // Prefer the /hooks-equivalent review flow; this flag is for automation.
  bypassHookTrust: bool("FLYNNCODE_BYPASS_HOOK_TRUST"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("OPENCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("OPENCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("OPENCODE_ENABLE_EXA"),
    legacy: bool("OPENCODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("OPENCODE_ENABLE_PARALLEL"),
    legacy: bool("OPENCODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("OPENCODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("OPENCODE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("OPENCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("OPENCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("OPENCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("OPENCODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("OPENCODE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("OPENCODE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

const BYPASS_HOOK_TRUST_ENV = "FLYNNCODE_BYPASS_HOOK_TRUST"

// `--dangerously-bypass-hook-trust` lives in process memory only. Putting it in
// process.env would hand the bypass to every hook command, shell tool and
// nested flynncode the session spawns.
let cliBypassHookTrust = false

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, bypassHookTrust: flags.bypassHookTrust || cliBypassHookTrust })
    }),
  ).pipe(Layer.provide(Service.layer), Layer.orDie),
  deps: [],
})

// Applies `--dangerously-bypass-hook-trust` for one invocation. Must run before
// the runtime builds RuntimeFlags (HooksExecutor reads it at construction).
export function applyDangerouslyBypassHookTrust(args: { "dangerously-bypass-hook-trust"?: boolean }) {
  if (args["dangerously-bypass-hook-trust"] === true) cliBypassHookTrust = true
}

// Env entries handing the CLI bypass to a worker thread that builds its own runtime.
export function bypassHookTrustWorkerEnv(): Record<string, string> {
  return cliBypassHookTrust ? { [BYPASS_HOOK_TRUST_ENV]: "1" } : {}
}

// Worker side of the hand-off: adopt the bypass in memory and drop it from
// the environment so processes the worker spawns do not inherit it.
export function adoptBypassHookTrustEnv() {
  const value = process.env[BYPASS_HOOK_TRUST_ENV]
  if (value === undefined) return
  delete process.env[BYPASS_HOOK_TRUST_ENV]
  if (value === "1" || value.toLowerCase() === "true") cliBypassHookTrust = true
}

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
