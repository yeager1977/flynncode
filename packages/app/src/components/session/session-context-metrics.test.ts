import { describe, expect, test } from "bun:test"
import type { Message } from "@flynncode/sdk/v2/client"
import { getSessionContext, getSessionModelUsage } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContext", () => {
  test("computes token totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 600, output: 200, reasoning: 100, read: 50, write: 50 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.message.id).toBe("a2")
    expect(ctx?.total).toBe(500)
    expect(ctx?.input).toBe(300)
    expect(ctx?.usage).toBe(50)
    expect(ctx?.providerLabel).toBe("OpenAI")
    expect(ctx?.modelLabel).toBe("GPT-4.1")
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.providerLabel).toBe("p-1")
    expect(ctx?.modelLabel).toBe("m-1")
    expect(ctx?.limit).toBeUndefined()
    expect(ctx?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContext(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContext(messages, providers)

    expect(one?.message.id).toBe("a1")
    expect(two?.message.id).toBe("a2")
  })

  test("returns undefined when inputs are undefined", () => {
    const ctx = getSessionContext(undefined, undefined)

    expect(ctx).toBeUndefined()
  })

  test("resolves a provider that is no longer connected through the lookup", () => {
    const messages = [user("u1"), assistant("a1", { input: 300, output: 100, reasoning: 0, read: 0, write: 0 }, 0)]
    const catalog = {
      id: "openai",
      name: "OpenAI",
      models: { "gpt-4.1": { name: "GPT-4.1", limit: { context: 1000 } } },
    }
    const asked: string[] = []
    const ctx = getSessionContext(messages, [], (providerID) => {
      asked.push(providerID)
      return catalog
    })

    expect(asked).toEqual(["openai"])
    expect(ctx?.providerLabel).toBe("OpenAI")
    expect(ctx?.modelLabel).toBe("GPT-4.1")
    expect(ctx?.limit).toBe(1000)
    expect(ctx?.usage).toBe(40)
  })

  test("does not look up a provider the connected list already has", () => {
    const messages = [assistant("a1", { input: 300, output: 100, reasoning: 0, read: 0, write: 0 }, 0)]
    const listed = { id: "openai", models: { "gpt-4.1": { name: "GPT-4.1", limit: { context: 1000 } } } }
    const ctx = getSessionContext(messages, [listed], () => {
      throw new Error("looked up")
    })

    expect(ctx?.limit).toBe(1000)
  })
})

describe("getSessionModelUsage", () => {
  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      models: { "gpt-5": { name: "GPT-5", limit: { context: 400_000 } } },
    },
    {
      id: "ollama-cloud",
      name: "Ollama.com",
      models: { "glm-5": { name: "GLM-5", limit: { context: 200_000 } } },
    },
  ]

  test("sums tokens and cost per provider and model, most recently used first", () => {
    const messages = [
      user("u1"),
      assistant(
        "a1",
        { input: 10_000, output: 800, reasoning: 0, read: 2_000, write: 0 },
        0.02,
        "ollama-cloud",
        "glm-5",
      ),
      user("u2"),
      assistant(
        "a2",
        { input: 30_000, output: 2_000, reasoning: 1_000, read: 5_000, write: 0 },
        0.3,
        "openai",
        "gpt-5",
      ),
      user("u3"),
      assistant(
        "a3",
        { input: 62_000, output: 3_000, reasoning: 1_000, read: 14_000, write: 0 },
        0.5,
        "openai",
        "gpt-5",
      ),
    ]

    const usage = getSessionModelUsage(messages, providers)

    expect(usage.map((entry) => `${entry.providerID}/${entry.modelID}`)).toEqual(["openai/gpt-5", "ollama-cloud/glm-5"])
    expect(usage[0].tokens).toBe(38_000 + 80_000)
    expect(usage[0].cost).toBeCloseTo(0.8)
    expect(usage[1].tokens).toBe(12_800)
    expect(usage[1].cost).toBeCloseTo(0.02)
  })

  test("ranks a model by its newest message, not by its first use", () => {
    const messages = [
      assistant("a1", { input: 100, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "openai", "gpt-5"),
      assistant("a2", { input: 100, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "ollama-cloud", "glm-5"),
      assistant("a3", { input: 100, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "openai", "gpt-5"),
    ]

    expect(getSessionModelUsage(messages, providers).map((entry) => entry.modelID)).toEqual(["gpt-5", "glm-5"])
  })

  test("resolves labels and the context limit the way getSessionContext does", () => {
    const messages = [
      assistant("a1", { input: 400, output: 100, reasoning: 0, read: 0, write: 0 }, 0.5, "openai", "gpt-5"),
    ]

    const [entry] = getSessionModelUsage(messages, providers)
    const ctx = getSessionContext(messages, providers)
    if (!ctx) throw new Error("expected a session context")

    expect(entry.providerLabel).toBe(ctx.providerLabel)
    expect(entry.modelLabel).toBe(ctx.modelLabel)
    expect(entry.limit).toBe(ctx.limit)
    expect(entry.providerLabel).toBe("OpenAI")
    expect(entry.modelLabel).toBe("GPT-5")
    expect(entry.limit).toBe(400_000)
  })

  test("falls back to the raw ids for a model the providers do not list", () => {
    const messages = [
      assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "gone", "old-model"),
    ]

    const [entry] = getSessionModelUsage(messages, providers)

    expect(entry.providerLabel).toBe("gone")
    expect(entry.modelLabel).toBe("old-model")
    expect(entry.limit).toBeUndefined()
  })

  test("resolves a provider that is no longer connected through the lookup", () => {
    const messages = [
      assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "openai", "gpt-5"),
    ]

    const [entry] = getSessionModelUsage(messages, [], (providerID) => providers.find((item) => item.id === providerID))

    expect(entry.modelLabel).toBe("GPT-5")
    expect(entry.limit).toBe(400_000)
  })

  test("skips user messages and assistant messages that have not reported tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 100, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "openai", "gpt-5"),
      user("u2"),
      assistant("a2", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0, "ollama-cloud", "glm-5"),
    ]

    expect(getSessionModelUsage(messages, providers).map((entry) => entry.modelID)).toEqual(["gpt-5"])
  })

  test("is empty without messages", () => {
    expect(getSessionModelUsage(undefined, undefined)).toEqual([])
    expect(getSessionModelUsage([user("u1")], providers)).toEqual([])
  })
})
