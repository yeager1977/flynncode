import type { Hooks, PluginInput, PluginOptions } from "@flynncode/plugin"
import type { Model } from "@flynncode/sdk/v2"
import { assignAgents, resolveTaskModel } from "./assign"
import {
  catalogStale,
  collectCandidates,
  ROUTER_MODEL_ID,
  ROUTER_PROVIDER_ID,
  type CatalogLike,
} from "./candidates"
import { MODEL_FAMILIES, type ModelFamily } from "./provider-family"
import { parseOptions, parseTaskVariant, ROUTER_VARIANTS, VALUE_TASK_WEIGHTS } from "./scorecard"
import { createTools, rankFor } from "./tools"
import type { RouterOptions, TaskName } from "./types"

const PREFIX = "[ollama-model-router]"

function readTupleOptions(options: PluginOptions | undefined): Record<string, unknown> | undefined {
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined
  return options as Record<string, unknown>
}

/**
 * Built-in Ollama model router.
 *
 * Options come from `model_router` in the merged opencode config. When the
 * plugin is loaded externally (path or npm spec), the options tuple is used as
 * a fallback so existing installations keep working during migration.
 */
export const OllamaModelRouterPlugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const tupleOptions = readTupleOptions(options)
  let currentOptions: RouterOptions | undefined
  let optionsError: string[] | undefined
  let currentConfig: any
  let assignments: Record<string, string> = {}
  // Provider blocks this plugin injected, so a later config pass can tell them
  // apart from a user's static `model-router` provider.
  const injected = new WeakSet<object>()

  const getOptions = () => currentOptions
  const getOptionsError = () => optionsError

  // The connected catalog (models.dev providers resolved by the server) is the
  // same source the model picker uses. Raw config is the fallback so headless
  // and unit-test callers keep working. Only `connected` providers count for
  // family resolution — the full models.dev `all` list includes providers the
  // user has no credentials for, which would make every family look available.
  // The snapshot is versioned: invalidation events mark it dirty and it ages
  // out after CATALOG_TTL_MS, so routing and tools see vendor connect/disconnect
  // and pulled models within a bounded window instead of a process-lifetime
  // snapshot.
  let catalog: CatalogLike | undefined
  let catalogLoadedAt = 0
  let catalogDirty = true
  let refetching: Promise<void> | undefined
  const getCatalog = (): CatalogLike | undefined => catalog
  const loadCatalog = async () => {
    if (catalog && !catalogDirty && !catalogStale(catalogLoadedAt, Date.now())) return
    // One fetch serves concurrent resolutions (prompt-time routing and tools).
    if (refetching) return refetching
    // Consumed now, before the fetch starts — not on success. An invalidation
    // event landing while this fetch is in flight re-dirties the flag
    // independently of this read, so the snapshot this fetch returns (which
    // may already be stale by the time it lands) gets refetched on the next
    // call instead of being trusted.
    catalogDirty = false
    refetching = (async () => {
      try {
        const result = await input.client.provider.list()
        const all = result.data?.all ?? []
        const connected = new Set(result.data?.connected ?? [])
        catalog = Object.fromEntries(
          all
            .filter((provider: any) => connected.has(provider.id))
            .map((provider: any) => [provider.id, { name: provider.name, models: provider.models ?? {} }]),
        ) as CatalogLike
        catalogLoadedAt = Date.now()
      } catch (error) {
        // A failed refetch keeps the last working snapshot (stale beats
        // nothing) but must stay due for retry — restore the dirty flag this
        // attempt consumed. A failed first load falls back to config
        // providers until one succeeds.
        catalogDirty = true
        console.warn(
          `${PREFIX} connected catalog unavailable; ${catalog ? "keeping last catalog" : "falling back to config providers"}`,
          error,
        )
      } finally {
        refetching = undefined
      }
    })()
    return refetching
  }

  // cfg.model_family is a top-level config key, not part of the model_router
  // tuple, and an invalid value degrades to "auto" so routing stays enabled.
  const readModelFamily = (cfg: any): ModelFamily => {
    const value = cfg?.model_family
    if (value === undefined) return "auto"
    if (MODEL_FAMILIES.includes(value)) return value
    console.warn(`${PREFIX} invalid model_family "${String(value)}"; using "auto"`)
    return "auto"
  }

  const resolveOptions = (cfg: any): { raw: Record<string, unknown> | undefined; source: string; modelFamily: ModelFamily } => {
    const modelFamily = readModelFamily(cfg)
    const fromConfig = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>).model_router : undefined
    if (fromConfig !== undefined) {
      return {
        raw:
          fromConfig && typeof fromConfig === "object" && !Array.isArray(fromConfig)
            ? (fromConfig as Record<string, unknown>)
            : {},
        source: "config.model_router",
        modelFamily,
      }
    }
    return { raw: tupleOptions, source: "plugin options", modelFamily }
  }

  // Selecting "Model Router" in the picker must not reach a provider API. When
  // the sentinel is present, resolve it to the concrete winner for the chosen
  // task (variant) or the active agent's task, and rewrite the transcript
  // message. The session preference keeps the sentinel so the picker stays put.
  const resolveSentinel = (options: RouterOptions, agent: string, variant: string | undefined) => {
    const parsed = parseTaskVariant(variant)
    const task = parsed?.task ?? taskForAgent(options, agent)
    // A `<task>-value` variant asks for the cheap lane, so it uses value weights
    // and ignores the task pin (a pin would otherwise re-impose the premium
    // model for tasks like review).
    const value = parsed?.value === true
    const model = resolveTaskModel(currentConfig, options, task, getCatalog(), {
      weights: value ? VALUE_TASK_WEIGHTS : undefined,
      ignorePin: value,
    })
    return { task, model }
  }

  // Custom agents without an agentTasks entry route as coding, the closest
  // match for general-purpose agents, instead of failing the prompt.
  const taskForAgent = (options: RouterOptions, agent: string): TaskName => {
    const task = options.agentTasks[agent]
    if (task) return task
    console.warn(`${PREFIX} agent "${agent}" has no agentTasks entry; routing it as "coding"`)
    return "coding"
  }

  // A static `model-router` block with its own endpoint is a real provider the
  // user defined; leave it alone. A copy of the injected sentinel block (name
  // and models only) has no endpoint and must not reach a provider API.
  const staticRouterProvider = () => {
    const block = currentConfig?.provider?.[ROUTER_PROVIDER_ID]
    if (!block || injected.has(block)) return false
    return Boolean(block.npm || block.api || block.options?.baseURL)
  }

  const allTools = createTools({
    client: input.client,
    directory: input.directory,
    getOptions,
    getOptionsError,
    getConfig: () => currentConfig,
    getCatalog,
    loadCatalog,
    getAssignments: () => assignments,
  })

  // The config hook owns the LLM-facing tool set: an inactive router (no
  // model_router config, no options tuple, parse failure, or enabled=false)
  // registers nothing, so sessions that never asked for routing don't pay
  // ~300-350 tokens per provider turn for unused definitions. This hook runs
  // before the tool registry snapshots plugin tools. auth_status is
  // diagnostics for this controller, not the model.
  const exposedTools: NonNullable<Hooks["tool"]> = {}
  const syncToolExposure = () => {
    for (const id of Object.keys(exposedTools)) delete exposedTools[id]
    if (!currentOptions || currentOptions.enabled === false) return
    for (const [id, def] of Object.entries(allTools ?? {})) {
      if (id === "auth_status") continue
      exposedTools[id] = def
    }
  }

  const applyConfig = async (cfg: any) => {
    currentConfig = cfg
    const { raw, source, modelFamily } = resolveOptions(cfg)
    if (raw === undefined) {
      // Built-in plugin with no `model_router` config and no options tuple:
      // stay silently inert so unconfigured users see no warnings.
      currentOptions = undefined
      optionsError = undefined
      return
    }
    const parsed = parseOptions(raw, modelFamily)
    if (!parsed.ok) {
      currentOptions = undefined
      optionsError = parsed.errors
      console.warn(`${PREFIX} invalid options (${source}); routing disabled:\n- ${parsed.errors.join("\n- ")}`)
      return
    }
    currentOptions = parsed.options
    optionsError = undefined
    if (!parsed.options.enabled) {
      assignments = {}
      return
    }

    warnShadowedRouter(cfg)
    injectRouterProvider(cfg)

    // Assignment mutates agent models and is legacy-only. Normal activation
    // is selecting Model Router, resolved at prompt time.
    const result = assignAgents(cfg, parsed.options)
    assignments = result.assignments
    for (const warning of result.warnings) console.warn(`${PREFIX} ${warning}`)
    if (Object.keys(result.assignments).length > 0) {
      console.info(
        `${PREFIX} agent routing: ` +
          Object.entries(result.assignments)
            .map(([agent, model]) => `${agent}→${model}`)
            .join(", "),
      )
    }
  }

  return {
    config: async (cfg) => {
      try {
        await applyConfig(cfg)
      } catch (error) {
        console.error(`${PREFIX} config hook failed; routing disabled`, error)
        currentOptions = undefined
      }
      syncToolExposure()
    },
    "chat.message": async (event, output) => {
      // Another plugin may have already replaced the sentinel; never touch a
      // concrete model.
      if (output.message.model.providerID !== ROUTER_PROVIDER_ID) return
      if (!currentOptions?.enabled) {
        if (staticRouterProvider()) return
        // Failing here is safer than sending the sentinel to a provider with
        // no baseURL. The prompt surfaces this message to the user.
        throw new Error(
          optionsError
            ? `Model Router is disabled because model_router options are invalid:\n- ${optionsError.join("\n- ")}`
            : "Model Router is disabled — enable model_router.enabled in your config or pick a concrete model.",
        )
      }
      await loadCatalog()
      const agent = output.message.agent || event.agent || "build"
      const resolved = resolveSentinel(currentOptions, agent, event.variant)
      if (!resolved.model) {
        const error = new Error(
          `Model Router has no eligible model for agent "${agent}" (task "${resolved.task}"). ` +
            `Check model_router providers, scorecards, and excludeModels.`,
        )
        console.error(`${PREFIX} chat.message hook failed`, error)
        throw error
      }
      const index = resolved.model.indexOf("/")
      output.message.model = {
        ...output.message.model,
        providerID: resolved.model.slice(0, index),
        modelID: resolved.model.slice(index + 1),
      }
    },
    event: async ({ event }) => {
      // The v1 Event union cannot express models-dev.refreshed or
      // integration.connection.updated (v2 events delivered over the shared
      // bus), so narrow at runtime. Both are location-less (global).
      const type = (event as { type?: string }).type
      if (type === "models-dev.refreshed" || type === "integration.connection.updated") catalogDirty = true
    },
    tool: exposedTools,
    // Auxiliary calls (title, memory, auto-review) otherwise fall back to the
    // routed flagship on ollama-family providers. Answer with the fast-tier
    // lookup winner for providers the router manages; anything else keeps its
    // own small-model resolution.
    "experimental.provider.small_model": async (incoming, output) => {
      if (!currentOptions || currentOptions.enabled === false) return
      const providerID = incoming.provider?.id
      if (!providerID) return
      await loadCatalog()
      const catalog = getCatalog()
      const candidates = collectCandidates(currentConfig, currentOptions, catalog)
      const winner = rankFor(currentConfig, candidates, currentOptions, "lookup", catalog).ranked[0]
      if (!winner || winner.providerID !== providerID) return
      const entry = catalog?.[winner.providerID]?.models?.[winner.modelID] as Model | undefined
      output.model = entry
    },
  }

  function warnShadowedRouter(cfg: any) {
    if (!cfg || typeof cfg !== "object") return
    const disabled: unknown = cfg.disabled_providers
    if (Array.isArray(disabled) && disabled.includes(ROUTER_PROVIDER_ID))
      console.warn(`${PREFIX} model_router is enabled but "${ROUTER_PROVIDER_ID}" is in disabled_providers; Model Router will not appear`)
    const enabled: unknown = cfg.enabled_providers
    if (Array.isArray(enabled) && !enabled.includes(ROUTER_PROVIDER_ID))
      console.warn(`${PREFIX} model_router is enabled but enabled_providers does not include "${ROUTER_PROVIDER_ID}"; Model Router will not appear`)
    const block = cfg.provider?.[ROUTER_PROVIDER_ID]
    if (block !== undefined && !injected.has(block))
      console.warn(`${PREFIX} a static provider.${ROUTER_PROVIDER_ID} block shadows the injected Model Router provider; remove it to use routing`)
  }

  function injectRouterProvider(cfg: any) {
    if (!cfg || typeof cfg !== "object") return
    if (!cfg.provider || typeof cfg.provider !== "object") cfg.provider = {}
    if (cfg.provider[ROUTER_PROVIDER_ID]) return
    const block = {
      name: "Model Router",
      models: {
        [ROUTER_MODEL_ID]: {
          name: "Model Router",
          tool_call: true,
          reasoning: true,
          limit: { context: 1000000, output: 65536 },
          variants: ROUTER_VARIANTS,
        },
      },
    }
    injected.add(block)
    cfg.provider[ROUTER_PROVIDER_ID] = block
  }
}

export default {
  id: "ollama-model-router",
  server: OllamaModelRouterPlugin,
}
