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

  test("enabled false leaves the sentinel unrewritten", async () => {
    const hooks = await plugin.server(fakeInput)
    const cfg: any = {
      model_router: { enabled: false, providers: ["ollama-cloud"] },
      provider: { "ollama-cloud": { models: { a: {} } } },
      agent: {},
    }
    await hooks.config?.(cfg)
    const message: any = { model: { providerID: "model-router", modelID: "auto" } }
    await hooks["chat.message"]?.(
      { sessionID: "s", agent: "build", model: { providerID: "model-router", modelID: "auto" } },
      { message, parts: [] },
    )
    expect(message.model).toEqual({ providerID: "model-router", modelID: "auto" })
  })

  test("rank_models reports disabled when enabled is false", async () => {
    const hooks = await plugin.server(fakeInput)
    const cfg: any = { model_router: { enabled: false } }
    await hooks.config?.(cfg)
    const output = await hooks.tool!.rank_models.execute({ task: "coding" } as any, { sessionID: "s" } as any)
    expect(String(output)).toBe("Model router disabled.")
  })
})
