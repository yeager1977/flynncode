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
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/fromTuple": { price: 1, capability: 10, speed: 10 } },
    })
    const cfg: any = {
      model_router: {
        autoRoute: true,
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

  test("cfg.model_router without autoRoute uses defaults", async () => {
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
    expect(cfg.agent.build.model).toBe("ollama-cloud/fromConfig")
  })
})
