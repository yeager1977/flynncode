import { describe, expect, test } from "bun:test"
import plugin from "../../../src/plugin/ollama-model-router"

const fakeInput = {
  client: {} as any,
  project: {} as any,
  directory: "/tmp",
  worktree: "/tmp",
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://localhost:4096"),
  $: undefined as any,
}

describe("plugin", () => {
  test("registers config hook and both tools", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: false,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/a": { price: 1, capability: 5, speed: 5 } },
    })
    expect(typeof hooks.config).toBe("function")
    expect(hooks.tool?.rank_models).toBeDefined()
    expect(hooks.tool?.route_task).toBeDefined()
  })

  test("config hook assigns agent models when autoRoute is true", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      models: {
        "ollama-cloud/a": { price: 1, capability: 5, speed: 5 },
        "ollama-cloud/b": { price: 9, capability: 10, speed: 5 },
      },
    })
    const cfg: any = {
      provider: { "ollama-cloud": { models: { a: {}, b: {} } } },
      agent: {},
      model: "should/not-change",
    }
    await hooks.config?.(cfg)
    expect(cfg.agent.build.model).toBe("ollama-cloud/b")
    expect(cfg.agent.plan.model).toBe("ollama-cloud/b")
    expect(cfg.model).toBe("should/not-change")
  })

  test("config hook honors an explicit per-task model override", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      taskModels: { coding: "ollama-cloud/weak" },
      models: {
        "ollama-cloud/strong": { price: 1, capability: 10, speed: 10 },
        "ollama-cloud/weak": { price: 9, capability: 2, speed: 2 },
      },
    })
    const cfg: any = {
      provider: { "ollama-cloud": { models: { strong: {}, weak: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    expect(cfg.agent.build.model).toBe("ollama-cloud/weak")
    expect(cfg.agent.plan.model).toBe("ollama-cloud/strong")
  })

  test("unscored models are eligible by default", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/scored": { price: 9, capability: 1, speed: 1 } },
    })
    const cfg: any = {
      provider: { "ollama-cloud": { models: { scored: {}, unscored: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    const output = await hooks.tool!.rank_models.execute({ task: "coding" } as any, { sessionID: "s" } as any)
    expect(String(output)).toContain("ollama-cloud/unscored")
    expect(String(output)).not.toContain("ollama-cloud/unscored (unscored")
  })

  test("config hook skips models listed in excludeModels", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      excludeModels: ["ollama-cloud/hidden"],
      models: {
        "ollama-cloud/visible": { price: 1, capability: 5, speed: 5 },
        "ollama-cloud/hidden": { price: 1, capability: 10, speed: 10 },
      },
    })
    const cfg: any = {
      provider: { "ollama-cloud": { models: { visible: {}, hidden: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    expect(cfg.agent.build.model).toBe("ollama-cloud/visible")
  })

  test("invalid options disable routing but keep tools", async () => {
    const hooks = await plugin.server(fakeInput, {
      models: { bad: { price: 99, capability: 1, speed: 1 } },
    })
    const cfg: any = { provider: {}, agent: {} }
    await hooks.config?.(cfg)
    expect(cfg.agent).toEqual({})
    expect(hooks.tool?.rank_models).toBeDefined()
  })

  test("options come from cfg.model_router when present", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/fromTuple": { price: 1, capability: 10, speed: 10 } },
    })
    const cfg: any = {
      model_router: {
        autoRoute: true,
        legacyAssign: true,
        providers: ["ollama-cloud"],
        models: { "ollama-cloud/fromConfig": { price: 1, capability: 10, speed: 10 } },
      },
      provider: { "ollama-cloud": { models: { fromConfig: {}, fromTuple: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    expect(cfg.agent.build.model).toBe("ollama-cloud/fromConfig")
  })

  test("falls back to tuple options when cfg.model_router is absent", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/fromTuple": { price: 1, capability: 10, speed: 10 } },
    })
    const cfg: any = {
      provider: { "ollama-cloud": { models: { fromTuple: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    expect(cfg.agent.build.model).toBe("ollama-cloud/fromTuple")
  })

  test("stays silent when no options source is configured", async () => {
    const hooks = await plugin.server(fakeInput)
    const cfg: any = { provider: {}, agent: {} }
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      await hooks.config?.(cfg)
    } finally {
      console.warn = original
    }
    expect(cfg.agent).toEqual({})
    expect(warnings).toEqual([])
  })

  test("config options take precedence over the options tuple", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: false,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/fromTuple": { price: 1, capability: 10, speed: 10 } },
    })
    const cfg: any = {
      model_router: {
        providers: ["ollama-cloud"],
        models: { "ollama-cloud/fromConfig": { price: 1, capability: 10, speed: 10 } },
      },
      provider: { "ollama-cloud": { models: { fromConfig: {}, fromTuple: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    const output = await hooks.tool!.rank_models.execute({ task: "coding" } as any, { sessionID: "s" } as any)
    expect(String(output)).toContain("ollama-cloud/fromConfig")
  })

  test("injects the virtual Model Router provider without touching agents", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/a": { price: 1, capability: 5, speed: 5 } },
    })
    const cfg: any = { provider: { "ollama-cloud": { models: { a: {} } } }, agent: {} }
    await hooks.config?.(cfg)
    expect(cfg.provider["model-router"]).toBeDefined()
    expect(cfg.provider["model-router"].models.auto).toBeDefined()
    expect(cfg.provider["model-router"].name).toBe("Model Router")
  })

  test("chat.message resolves the sentinel to the task winner and leaves concrete models alone", async () => {
    const hooks = await plugin.server(fakeInput, {
      providers: ["ollama-cloud"],
      agentTasks: { build: "coding" },
      models: { "ollama-cloud/code": { price: 1, capability: 10, speed: 10 } },
    })
    const cfg: any = { provider: { "ollama-cloud": { models: { code: {} } } }, agent: {} }
    await hooks.config?.(cfg)

    const message: any = {
      model: { providerID: "model-router", modelID: "auto" },
    }
    await hooks["chat.message"]?.(
      { sessionID: "s", agent: "build", model: { providerID: "model-router", modelID: "auto" } },
      { message, parts: [] },
    )
    expect(message.model).toEqual({ providerID: "ollama-cloud", modelID: "code" })

    const concrete: any = { model: { providerID: "anthropic", modelID: "claude-sonnet-5" } }
    await hooks["chat.message"]?.(
      { sessionID: "s", agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5" } },
      { message: concrete, parts: [] },
    )
    expect(concrete.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5" })
  })

  test("chat.message routes a value variant through value weights, dropping the pin", async () => {
    const hooks = await plugin.server(fakeInput, {
      providers: ["ollama-cloud"],
      agentTasks: { build: "coding" },
      taskModels: { review: "ollama-cloud/premium" },
      models: {
        "ollama-cloud/premium": { price: 8, capability: 10, speed: 4 },
        "ollama-cloud/cheap": { price: 1, capability: 6, speed: 9 },
      },
    })
    const cfg: any = { provider: { "ollama-cloud": { models: { premium: {}, cheap: {} } } }, agent: {} }
    await hooks.config?.(cfg)

    const premium: any = { model: { providerID: "model-router", modelID: "auto" } }
    await hooks["chat.message"]?.(
      { sessionID: "s", agent: "build", model: { providerID: "model-router", modelID: "auto" } },
      { message: premium, parts: [] },
    )
    expect(premium.model).toEqual({ providerID: "ollama-cloud", modelID: "premium" })

    const cheap: any = { model: { providerID: "model-router", modelID: "auto" } }
    await hooks["chat.message"]?.(
      {
        sessionID: "s",
        agent: "build",
        model: { providerID: "model-router", modelID: "auto" },
        variant: "review-value",
      },
      { message: cheap, parts: [] },
    )
    expect(cheap.model).toEqual({ providerID: "ollama-cloud", modelID: "cheap" })
  })

  test("chat.message honors a task-named variant over the agent mapping", async () => {
    const hooks = await plugin.server(fakeInput, {
      providers: ["ollama-cloud"],
      agentTasks: { build: "coding" },
      models: {
        "ollama-cloud/code": { price: 1, capability: 10, speed: 10 },
        "ollama-cloud/reviewer": { price: 1, capability: 10, speed: 10 },
      },
    })
    const cfg: any = { provider: { "ollama-cloud": { models: { code: {}, reviewer: {} } } }, agent: {} }
    await hooks.config?.(cfg)
    await hooks["chat.message"]?.(
      { sessionID: "s", agent: "build", model: { providerID: "model-router", modelID: "auto" }, variant: "review" },
      { message: { model: { providerID: "model-router", modelID: "auto" } } as any, parts: [] },
    )
    const output = await hooks.tool!.rank_models.execute({ task: "review" } as any, { sessionID: "s" } as any)
    expect(String(output)).toContain("ollama-cloud/reviewer")
  })

  test("enabled false does not inject the sentinel or assign agents", async () => {
    const hooks = await plugin.server(fakeInput, {
      enabled: false,
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/a": { price: 1, capability: 10, speed: 10 } },
    })
    const cfg: any = {
      model_router: {
        enabled: false,
        autoRoute: true,
        legacyAssign: true,
        providers: ["ollama-cloud"],
        models: { "ollama-cloud/a": { price: 1, capability: 10, speed: 10 } },
      },
      provider: { "ollama-cloud": { models: { a: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    expect(cfg.provider["model-router"]).toBeUndefined()
    expect(cfg.agent).toEqual({})
  })

  test("enabled false fails the sentinel with a clear error instead of leaking it", async () => {
    const hooks = await plugin.server(fakeInput)
    const cfg: any = {
      model_router: { enabled: false, providers: ["ollama-cloud"] },
      provider: { "ollama-cloud": { models: { a: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    const message: any = { model: { providerID: "model-router", modelID: "auto" } }
    const result = hooks["chat.message"]?.(
      { sessionID: "s", agent: "build", model: { providerID: "model-router", modelID: "auto" } },
      { message, parts: [] },
    )
    await expect(result).rejects.toThrow("Model Router is disabled — enable model_router.enabled")
    expect(message.model).toEqual({ providerID: "model-router", modelID: "auto" })
  })

  test("invalid options fail the sentinel naming the option errors", async () => {
    const hooks = await plugin.server(fakeInput)
    await hooks.config?.({ model_router: { providers: "nope" } } as any)
    const result = hooks["chat.message"]?.(
      { sessionID: "s", agent: "build" },
      { message: { agent: "build", model: { providerID: "model-router", modelID: "auto" } } as any, parts: [] },
    )
    await expect(result).rejects.toThrow("providers must be an array of strings")
  })

  test("a static model-router provider is left alone while routing is off", async () => {
    const hooks = await plugin.server(fakeInput)
    await hooks.config?.({ provider: { "model-router": { options: { baseURL: "http://x" }, models: { auto: {} } } } } as any)
    const message: any = { agent: "build", model: { providerID: "model-router", modelID: "auto" } }
    await hooks["chat.message"]?.({ sessionID: "s", agent: "build" }, { message, parts: [] })
    expect(message.model).toEqual({ providerID: "model-router", modelID: "auto" })
  })

  test("a static copy of the sentinel block without an endpoint still fails while routing is off", async () => {
    const hooks = await plugin.server(fakeInput)
    await hooks.config?.({
      model_router: { enabled: false },
      disabled_providers: ["model-router"],
      provider: { "model-router": { name: "Model Router", models: { auto: {} } } },
    } as any)
    const result = hooks["chat.message"]?.(
      { sessionID: "s", agent: "build" },
      { message: { agent: "build", model: { providerID: "model-router", modelID: "auto" } } as any, parts: [] },
    )
    await expect(result).rejects.toThrow("Model Router is disabled")
  })

  test("routes by the message's resolved agent and falls back to coding for unmapped agents", async () => {
    const hooks = await plugin.server(fakeInput, {
      providers: ["ollama-cloud"],
      taskModels: { coding: "ollama-cloud/code", lookup: "ollama-cloud/look" },
      models: {
        "ollama-cloud/code": { price: 1, capability: 10, speed: 10 },
        "ollama-cloud/look": { price: 1, capability: 10, speed: 10 },
      },
    })
    await hooks.config?.({ provider: { "ollama-cloud": { models: { code: {}, look: {} } } }, agent: {} } as any)
    // No agent in the prompt input: the message carries the resolved agent.
    const explore: any = { agent: "explore", model: { providerID: "model-router", modelID: "auto" } }
    await hooks["chat.message"]?.({ sessionID: "s" }, { message: explore, parts: [] })
    expect(explore.model).toEqual({ providerID: "ollama-cloud", modelID: "look" })

    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    const custom: any = { agent: "my-reviewer", model: { providerID: "model-router", modelID: "auto" } }
    await hooks["chat.message"]?.({ sessionID: "s", agent: "my-reviewer" }, { message: custom, parts: [] }).finally(() => {
      console.warn = original
    })
    expect(custom.model).toEqual({ providerID: "ollama-cloud", modelID: "code" })
    expect(warnings.some((args) => String(args[0]).includes('agent "my-reviewer"'))).toBe(true)
  })

  test("the no-eligible-model error names the agent and task", async () => {
    const hooks = await plugin.server(fakeInput, { providers: ["ollama-cloud"], allowUnscored: false, models: {} })
    await hooks.config?.({ provider: {}, agent: {} } as any)
    const result = hooks["chat.message"]?.(
      { sessionID: "s" },
      { message: { agent: "plan", model: { providerID: "model-router", modelID: "auto" } } as any, parts: [] },
    )
    await expect(result).rejects.toThrow('agent "plan" (task "planning")')
  })

  test("warns when model-router is disabled or shadowed by a static provider block", async () => {
    const hooks = await plugin.server(fakeInput, { providers: ["ollama-cloud"], models: {} })
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    await hooks.config?.({ disabled_providers: ["model-router"], provider: {} } as any)
    await hooks.config?.({ provider: { "model-router": { models: {} } } } as any)
    const cfg: any = { provider: {} }
    await hooks.config?.(cfg)
    await hooks.config?.(cfg)
    console.warn = original
    const text = warnings.map((args) => String(args[0]))
    expect(text.filter((line) => line.includes("disabled_providers"))).toHaveLength(1)
    // The re-run over an already-injected config must not count as shadowing.
    expect(text.filter((line) => line.includes("shadows"))).toHaveLength(1)
  })

  test("rank_models reports disabled when enabled is false", async () => {
    const hooks = await plugin.server(fakeInput)
    const cfg: any = { model_router: { enabled: false } }
    await hooks.config?.(cfg)
    const output = await hooks.tool!.rank_models.execute({ task: "coding" } as any, { sessionID: "s" } as any)
    expect(String(output)).toBe("Model router disabled.")
  })

  const familyCfg = (model_family: unknown): any => ({
    model_family,
    provider: {
      "ollama-cloud": { models: { "glm-5.3-flash": {}, "deepseek-v4-pro": {} } },
      openai: { models: { "gpt-6-sol": {}, "gpt-6-sol-fast": {} } },
    },
    agent: {},
  })

  const familyOptions = {
    providers: ["ollama-cloud", "openai"],
    models: {
      "ollama-cloud/glm-5.3-flash": { price: 3, capability: 8, speed: 9 },
      "ollama-cloud/deepseek-v4-pro": { price: 6, capability: 10, speed: 6 },
      "openai/gpt-6-sol": { price: 9, capability: 4, speed: 4 },
    },
  }

  const routeSentinel = async (hooks: Awaited<ReturnType<typeof plugin.server>>, cfg: any, agent = "build") => {
    const message: any = { model: { providerID: "model-router", modelID: "auto" } }
    await hooks["chat.message"]?.(
      { sessionID: "s", agent, model: { providerID: "model-router", modelID: "auto" } },
      { message, parts: [] },
    )
    return message.model
  }

  test("model_family openai routes coding to the tier model", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: false,
      agentTasks: { build: "coding" },
      ...familyOptions,
    } as any)
    const cfg = familyCfg("openai")
    await hooks.config?.(cfg)
    const model = await routeSentinel(hooks, cfg)
    expect(model).toEqual({ providerID: "openai", modelID: "gpt-6-sol" })
  })

  test("model_family auto preserves the exact current winner", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: false,
      agentTasks: { build: "coding" },
      ...familyOptions,
    } as any)
    const cfg = familyCfg("auto")
    await hooks.config?.(cfg)
    const model = await routeSentinel(hooks, cfg)
    expect(model).toEqual({ providerID: "ollama-cloud", modelID: "deepseek-v4-pro" })
  })

  test("an explicit taskModels pin beats model_family", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: false,
      agentTasks: { build: "coding" },
      taskModels: { coding: "ollama-cloud/glm-5.3-flash" },
      ...familyOptions,
    } as any)
    const cfg = familyCfg("openai")
    await hooks.config?.(cfg)
    const model = await routeSentinel(hooks, cfg)
    expect(model).toEqual({ providerID: "ollama-cloud", modelID: "glm-5.3-flash" })
  })

  test("a value-variant sentinel keeps existing scoring despite model_family", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: false,
      agentTasks: { build: "coding" },
      ...familyOptions,
    } as any)
    const cfg = familyCfg("openai")
    await hooks.config?.(cfg)
    const message: any = { model: { providerID: "model-router", modelID: "auto" } }
    await hooks["chat.message"]?.(
      {
        sessionID: "s",
        agent: "build",
        model: { providerID: "model-router", modelID: "auto" },
        variant: "coding-value",
      },
      { message, parts: [] },
    )
    expect(message.model).toEqual({ providerID: "ollama-cloud", modelID: "glm-5.3-flash" })
  })

  test("an invalid model_family degrades to auto behavior", async () => {
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    const hooks = await plugin.server(fakeInput, {
      autoRoute: false,
      agentTasks: { build: "coding" },
      ...familyOptions,
    } as any)
    const cfg = familyCfg("mistral")
    try {
      await hooks.config?.(cfg)
    } finally {
      console.warn = original
    }
    const model = await routeSentinel(hooks, cfg)
    expect(model).toEqual({ providerID: "ollama-cloud", modelID: "deepseek-v4-pro" })
    expect(warnings.some((args) => args.some((a) => String(a).includes("invalid model_family")))).toBe(true)
  })

  test("the catalog counts only connected providers for family resolution", async () => {
    const input = {
      ...fakeInput,
      client: {
        provider: {
          list: async () => ({
            data: {
              // The full models.dev catalog lists both, but only openai is
              // connected; with no openai credential the openai family must
              // not look available to the fallback walk.
              all: [
                { id: "openai", models: { "gpt-6-sol": {} } },
                { id: "anthropic", models: { "claude-sonnet-5": {} } },
              ],
              connected: ["anthropic"],
            },
          }),
        },
      } as any,
    }
    const hooks = await plugin.server(input, {
      autoRoute: false,
      agentTasks: { build: "review" },
      providers: [],
      models: {},
    } as any)
    const cfg = { model_family: "openai", provider: {}, agent: {} }
    await hooks.config?.(cfg)
    const model = await routeSentinel(hooks, cfg)
    // No openai credential, so the fallback walks past openai to anthropic.
    expect(model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5" })
  })

  describe("catalog freshness", () => {
    const connectedList = (connected: string[]) => ({
      all: [
        { id: "ollama-cloud", models: { a: {} } as Record<string, unknown> },
        { id: "anthropic", models: { "claude-fable-5-1": {} } as Record<string, unknown> },
      ],
      connected,
    })

    const catalogueOptions = {
      autoRoute: false,
      agentTasks: { build: "coding" },
      providers: ["anthropic", "ollama-cloud"],
      models: {},
    }

    const setup = async (client: any) => {
      const hooks = await plugin.server({ ...fakeInput, client }, catalogueOptions as any)
      await hooks.config?.({ provider: { "ollama-cloud": { models: { a: {} } }, "anthropic": { models: {} } } } as any)
      return hooks
    }

    test("chat.message refetches the catalog after integration.connection.updated", async () => {
      const lists = [connectedList(["ollama-cloud"]), connectedList(["ollama-cloud", "anthropic"])]
      let call = 0
      const hooks = await setup({
        provider: { list: async () => ({ data: lists[call++] ?? lists[lists.length - 1] }), },
      })
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({ providerID: "ollama-cloud", modelID: "a" })
      await hooks.event?.({ event: { id: "e", type: "integration.connection.updated", properties: {} } } as any)
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
      })
    })

    test("models-dev.refreshed still invalidates the catalog", async () => {
      let calls = 0
      const hooks = await setup({
        provider: { list: async () => { calls++; return { data: connectedList(["ollama-cloud", "anthropic"]) } } },
      })
      await routeSentinel(hooks, { provider: {} } as any)
      expect(calls).toBe(1)
      await hooks.event?.({ event: { id: "e", type: "models-dev.refreshed", properties: {} } } as any)
      await routeSentinel(hooks, { provider: {} } as any)
      expect(calls).toBe(2)
    })

    test("a failed refetch keeps the last working catalog and recovers on the next trigger", async () => {
      const lists: Array<unknown> = [connectedList(["ollama-cloud"]), new Error("boom"), connectedList(["ollama-cloud", "anthropic"])]
      let call = 0
      const hooks = await setup({
        provider: {
          list: async () => {
            const value = lists[call++]
            if (value instanceof Error) throw value
            return { data: value }
          },
        },
      })
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({ providerID: "ollama-cloud", modelID: "a" })
      await hooks.event?.({ event: { id: "e", type: "integration.connection.updated", properties: {} } } as any)
      // Refetch fails; routing still resolves against the retained catalog.
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({ providerID: "ollama-cloud", modelID: "a" })
      // Still dirty: the next routing refetches and picks up anthropic.
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
      })
    })

    test("concurrent resolutions share one refetch", async () => {
      let calls = 0
      const hooks = await setup({
        provider: {
          list: async () => {
            calls++
            await Bun.sleep(2)
            return { data: connectedList(["ollama-cloud", "anthropic"]) }
          },
        },
      })
      const [one, two] = await Promise.all([
        routeSentinel(hooks, { provider: {} } as any),
        routeSentinel(hooks, { provider: {} } as any),
      ])
      expect(calls).toBe(1)
      expect(one).toEqual(two)
      await routeSentinel(hooks, { provider: {} } as any)
      expect(calls).toBe(1)
    })
  })
})
