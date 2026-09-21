import { describe, expect, test } from "bun:test"
import {
  DEFAULT_AGENT_TASKS,
  DEFAULT_TASK_WEIGHTS,
  type ModelRouterFormState,
  TASK_NAMES,
  type TaskName,
  emptyForm,
  formFromConfig,
  isRouterModel,
  modelAfterDisable,
  serializeForm,
  validateForm,
} from "./model-router-payload"

describe("emptyForm", () => {
  test("matches plugin defaults", () => {
    const form = emptyForm()
    expect(form).toEqual({
      enabled: true,
      autoRoute: true,
      allowUnscored: true,
      overrideExplicit: false,
      legacyAssign: false,
      providers: [],
      agentTasks: [
        { agent: "build", task: "coding" },
        { agent: "plan", task: "planning" },
        { agent: "explore", task: "lookup" },
        { agent: "general", task: "coding" },
      ],
      taskWeights: DEFAULT_TASK_WEIGHTS,
      taskModels: {},
      excludeModels: [],
      models: [],
    } satisfies ModelRouterFormState)
    expect(form.agentTasks.map((row) => [row.agent, row.task])).toEqual(Object.entries(DEFAULT_AGENT_TASKS))
    expect(TASK_NAMES).toEqual(["coding", "planning", "review", "architecture", "lookup", "writing", "long-context"])
  })
})

describe("formFromConfig", () => {
  test("empty object equals emptyForm", () => {
    expect(formFromConfig({})).toEqual(emptyForm())
  })

  test("undefined equals emptyForm", () => {
    expect(formFromConfig(undefined)).toEqual(emptyForm())
  })

  test("partial config preserves configured values and fills defaults", () => {
    const form = formFromConfig({
      autoRoute: false,
      providers: ["ollama"],
      models: { "ollama/llama3.1": { price: 7, capability: 8, speed: 6, tags: ["coding"] } },
    })
    expect(form.autoRoute).toBe(false)
    expect(form.allowUnscored).toBe(true)
    expect(form.providers).toEqual(["ollama"])
    expect(form.agentTasks.map((row) => row.agent)).toEqual(Object.keys(DEFAULT_AGENT_TASKS))
    expect(form.taskWeights).toEqual(DEFAULT_TASK_WEIGHTS)
    expect(form.models).toEqual([
      { key: "ollama/llama3.1", tags: ["coding"], price: 7, capability: 8, speed: 6 },
    ])
  })

  test("agentTasks replaces the standard mappings", () => {
    const form = formFromConfig({ agentTasks: { build: "review" } })
    expect(form.agentTasks).toEqual([{ agent: "build", task: "review" }])
  })

  test("taskWeights merge over defaults", () => {
    const form = formFromConfig({ taskWeights: { coding: { capability: 0.9, price: 0.05, speed: 0.05 } } })
    expect(form.taskWeights.coding).toEqual({ capability: 0.9, price: 0.05, speed: 0.05 })
    expect(form.taskWeights.planning).toEqual(DEFAULT_TASK_WEIGHTS.planning)
  })

  test("malformed values fall back to defaults", () => {
    const form = formFromConfig({
      autoRoute: "yes",
      allowUnscored: 1,
      providers: ["ollama", 42],
      agentTasks: "nope",
      taskWeights: { coding: "nope" },
      taskModels: "nope",
      models: ["nope"],
    })
    expect(form).toEqual(emptyForm())
  })

  test("taskModels keeps valid entries and drops malformed ones", () => {
    const form = formFromConfig({
      taskModels: { coding: "ollama/glm", planning: 42, nope: "ollama/x" },
    })
    expect(form.taskModels).toEqual({ coding: "ollama/glm" })
  })

  test("excludeModels keeps valid keys and drops malformed ones", () => {
    const form = formFromConfig({ excludeModels: ["ollama/glm", "no-slash", 42] })
    expect(form.excludeModels).toEqual(["ollama/glm"])
  })

  test("overrideExplicit preserves true", () => {
    const form = formFromConfig({ overrideExplicit: true })
    expect(form.overrideExplicit).toBe(true)
  })

  test("invalid model entries keep the key with fallback scores", () => {
    const form = formFromConfig({
      models: { "ollama/bad": { price: 22, capability: "high", tags: ["nonsense"] }, "no-slash": 5 },
    })
    expect(form.models).toEqual([{ key: "ollama/bad", tags: [], price: 5, capability: 5, speed: 5 }])
  })
})

describe("serializeForm", () => {
  test("empty form serializes to the default object", () => {
    expect(serializeForm(emptyForm())).toEqual({
      enabled: true,
      autoRoute: true,
      allowUnscored: true,
      overrideExplicit: false,
      legacyAssign: false,
      providers: [],
      agentTasks: DEFAULT_AGENT_TASKS,
      taskWeights: DEFAULT_TASK_WEIGHTS,
    })
  })

  test("omits models, taskModels, and excludeModels when empty", () => {
    expect("models" in serializeForm(emptyForm())).toBe(false)
    expect("taskModels" in serializeForm(emptyForm())).toBe(false)
    expect("excludeModels" in serializeForm(emptyForm())).toBe(false)
  })

  test("includes taskModels when set", () => {
    const form: ModelRouterFormState = { ...emptyForm(), taskModels: { coding: "ollama/glm" } }
    expect(serializeForm(form).taskModels).toEqual({ coding: "ollama/glm" })
  })

  test("includes excludeModels when set and round-trips them", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      excludeModels: ["ollama-cloud/hidden", "ollama-gpu/off"],
    }
    const serialized = serializeForm(form)
    expect(serialized.excludeModels).toEqual(["ollama-cloud/hidden", "ollama-gpu/off"])
    expect(formFromConfig(serialized).excludeModels).toEqual(["ollama-cloud/hidden", "ollama-gpu/off"])
  })

  test("a cleared pin (undefined) is omitted, keeping the form clean", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      taskModels: { coding: "ollama/glm", planning: undefined },
    }
    expect("taskModels" in serializeForm(form)).toBe(true)
    expect(serializeForm(form).taskModels).toEqual({ coding: "ollama/glm" })
    const cleared = serializeForm({ ...emptyForm(), taskModels: { coding: undefined } })
    expect("taskModels" in cleared).toBe(false)
    expect(formFromConfig(cleared)).toEqual(emptyForm())
  })

  test("includes models with tags when set", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      models: [{ key: "ollama/llama3.1", tags: ["coding", "review"], price: 4, capability: 9, speed: 3 }],
    }
    expect(serializeForm(form)).toEqual({
      enabled: true,
      autoRoute: true,
      allowUnscored: true,
      overrideExplicit: false,
      legacyAssign: false,
      providers: [],
      agentTasks: DEFAULT_AGENT_TASKS,
      taskWeights: DEFAULT_TASK_WEIGHTS,
      models: { "ollama/llama3.1": { price: 4, capability: 9, speed: 3, tags: ["coding", "review"] } },
    })
  })

  test("omits empty tags from model entries", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      models: [{ key: "ollama/llama3.1", tags: [], price: 4, capability: 9, speed: 3 }],
    }
    expect(serializeForm(form).models).toEqual({ "ollama/llama3.1": { price: 4, capability: 9, speed: 3 } })
  })

  test("emits overrideExplicit when true", () => {
    const form: ModelRouterFormState = { ...emptyForm(), overrideExplicit: true }
    expect(serializeForm(form).overrideExplicit).toBe(true)
  })
})

describe("validateForm", () => {
  test("duplicate agent assignments cannot silently overwrite one another", () => {
    const form = emptyForm()
    form.agentTasks.push({ agent: "build", task: "review" })
    expect(validateForm(form)).toEqual({ ok: false, errors: ["agentTasks.build.duplicate"] })
  })

  test("invalid task weights cannot reach the router config", () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const form = emptyForm()
      form.taskWeights.coding.speed = value
      expect(validateForm(form)).toEqual({ ok: false, errors: ["taskWeights.coding.speed"] })
    }
  })

  test("zero weights remain valid for the router's equal-weight fallback", () => {
    const form = emptyForm()
    form.taskWeights.coding = { capability: 0, price: 0, speed: 0 }
    expect(validateForm(form).ok).toBe(true)
  })

  test("empty form is valid", () => {
    const result = validateForm(emptyForm())
    expect(result).toEqual({ ok: true, value: serializeForm(emptyForm()) })
  })

  test("bad model key rejected", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      models: [{ key: "noprovider", tags: [], price: 5, capability: 5, speed: 5 }],
    }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["models.noprovider.key"] })
  })

  test("model key with empty sides rejected", () => {
    for (const key of ["/model", "provider/", "/"]) {
      const form: ModelRouterFormState = {
        ...emptyForm(),
        models: [{ key, tags: [], price: 5, capability: 5, speed: 5 }],
      }
      expect(validateForm(form).ok).toBe(false)
    }
  })

  test("score out of range rejected", () => {
    for (const price of [0, 11]) {
      const form: ModelRouterFormState = {
        ...emptyForm(),
        models: [{ key: "ollama/x", tags: [], price, capability: 5, speed: 5 }],
      }
      expect(validateForm(form)).toEqual({ ok: false, errors: ["models.ollama/x.price"] })
    }
  })

  test("non-integer score rejected", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      models: [{ key: "ollama/x", tags: [], price: 5.5, capability: 5, speed: 5 }],
    }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["models.ollama/x.price"] })
  })

  test("capability out of range rejected", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      models: [{ key: "ollama/x", tags: [], price: 5, capability: 11, speed: 5 }],
    }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["models.ollama/x.capability"] })
  })

  test("unknown task name in agent rows rejected", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      agentTasks: [{ agent: "build", task: "nonsense" as unknown as TaskName }],
    }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["agentTasks.build.task"] })
  })

  test("unknown tag rejected", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      models: [{ key: "ollama/x", tags: ["nonsense" as unknown as TaskName], price: 5, capability: 5, speed: 5 }],
    }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["models.ollama/x.tags"] })
  })

  test("duplicate model keys rejected", () => {
    const row = { key: "ollama/x", tags: [], price: 5, capability: 5, speed: 5 }
    const form: ModelRouterFormState = { ...emptyForm(), models: [row, { ...row, price: 6 }] }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["models.duplicate"] })
  })

  test("empty agent name rejected", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      agentTasks: [{ agent: "  ", task: "coding" }],
    }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["agentTasks..agent"] })
  })

  test("whitespace agent name with unknown task rejected", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      agentTasks: [{ agent: "  ", task: "nonsense" as unknown as TaskName }],
    }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["agentTasks..agent", "agentTasks..task"] })
  })

  test("empty provider rejected", () => {
    const form: ModelRouterFormState = { ...emptyForm(), providers: ["", "ollama"] }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["providers.0"] })
  })

  test("malformed taskModels override rejected", () => {
    const form: ModelRouterFormState = { ...emptyForm(), taskModels: { coding: "no-slash" } }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["taskModels.coding"] })
  })

  test("malformed excludeModels entry rejected", () => {
    const form: ModelRouterFormState = { ...emptyForm(), excludeModels: ["ollama/ok", "no-slash"] }
    expect(validateForm(form)).toEqual({ ok: false, errors: ["excludeModels.1"] })
  })

  test("valid form passes and serializes", () => {
    const form: ModelRouterFormState = {
      ...emptyForm(),
      models: [{ key: "ollama/llama3.1", tags: ["coding"], price: 3, capability: 10, speed: 2 }],
    }
    const result = validateForm(form)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.models).toEqual({
        "ollama/llama3.1": { price: 3, capability: 10, speed: 2, tags: ["coding"] },
      })
    }
  })
})

describe("round trip", () => {
  test("formFromConfig(serializeForm(emptyForm())) equals emptyForm", () => {
    expect(formFromConfig(serializeForm(emptyForm()) as Record<string, unknown>)).toEqual(emptyForm())
  })

  test("round-trips a populated form", () => {
    const form: ModelRouterFormState = {
      enabled: true,
      autoRoute: false,
      allowUnscored: true,
      overrideExplicit: true,
      legacyAssign: true,
      providers: ["ollama", "openai"],
      agentTasks: [{ agent: "build", task: "review" }],
      taskWeights: { ...DEFAULT_TASK_WEIGHTS, coding: { capability: 0.8, price: 0.1, speed: 0.1 } },
      taskModels: { coding: "ollama/qwen3" },
      excludeModels: ["ollama/hidden"],
      models: [{ key: "ollama/qwen3", tags: ["writing"], price: 2, capability: 7, speed: 9 }],
    }
    expect(formFromConfig(serializeForm(form) as Record<string, unknown>)).toEqual(form)
  })
})

test("defaults enabled to true", () => {
  expect(emptyForm().enabled).toBe(true)
  expect(formFromConfig({}).enabled).toBe(true)
})

test("parses and serializes enabled false", () => {
  const form = formFromConfig({ enabled: false })
  expect(form.enabled).toBe(false)
  expect(serializeForm(form).enabled).toBe(false)
})

test("isRouterModel detects the sentinel", () => {
  expect(isRouterModel("model-router/auto")).toBe(true)
  expect(isRouterModel("model-router/coding")).toBe(true)
  expect(isRouterModel("ollama-cloud/glm-5.3-flash")).toBe(false)
})

test("modelAfterDisable retargets sentinel to small_model", () => {
  expect(modelAfterDisable("model-router/auto", "ollama-cloud/glm-5.3-flash")).toBe("ollama-cloud/glm-5.3-flash")
})

test("modelAfterDisable leaves model unchanged without small_model", () => {
  expect(modelAfterDisable("model-router/auto", undefined)).toBe("model-router/auto")
})

test("modelAfterDisable leaves a concrete model unchanged", () => {
  expect(modelAfterDisable("xai/grok-4.6", "ollama-cloud/glm-5.3-flash")).toBe("xai/grok-4.6")
})
