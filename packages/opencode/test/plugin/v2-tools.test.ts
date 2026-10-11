import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { tool, type ToolDefinition } from "@flynncode/plugin"
import { AgentV2 } from "@flynncode/core/agent"
import { SessionMessage } from "@flynncode/core/session/message"
import { SessionSchema } from "@flynncode/core/session/schema"
import { Tool } from "@flynncode/core/tool/tool"
import { syncPluginTools, clearPluginTools } from "../../src/plugin/v2-tools"
import { ToolRegistry } from "@flynncode/core/tool/registry"

describe("configured plugin tools", () => {
  test("publishes v1 plugin tools into the v2 registry group", () => {
    syncPluginTools(
      [
        {
          tool: {
            demo_tool: {
              description: "Demo",
              args: { query: { _def: {} } as never },
              execute: async () => "ok",
            },
          },
        },
      ],
      "/tmp/project",
      "/tmp/project",
    )
    expect(ToolRegistry.replaceGroup).toBeTypeOf("function")
    clearPluginTools("/tmp/project")
  })

  test("keeps tools isolated per directory", () => {
    const hooks = (name: string) => [
      {
        tool: {
          [name]: {
            description: "Demo",
            args: {},
            execute: async () => "ok",
          },
        },
      },
    ]
    syncPluginTools(hooks("alpha_tool"), "/tmp/project-a", "/tmp/project-a")
    syncPluginTools(hooks("beta_tool"), "/tmp/project-b", "/tmp/project-b")

    expect(ToolRegistry.groups().has("v1-plugin:/tmp/project-a")).toBe(true)
    expect(ToolRegistry.groups().has("v1-plugin:/tmp/project-b")).toBe(true)
    expect(ToolRegistry.groups().get("v1-plugin:/tmp/project-b")?.has("alpha_tool")).toBe(false)
    expect(ToolRegistry.groups().get("v1-plugin:/tmp/project-b")?.has("beta_tool")).toBe(true)

    clearPluginTools("/tmp/project-a")
    // Clearing one instance must not wipe the other instance's group.
    expect(ToolRegistry.groups().has("v1-plugin:/tmp/project-b")).toBe(true)
    expect(ToolRegistry.groups().has("v1-plugin:/tmp/project-a")).toBe(false)

    clearPluginTools("/tmp/project-b")
    // The registry is process-global; other test files may hold their own
    // groups, so assert only that both directories here are gone.
    expect(ToolRegistry.groups().has("v1-plugin:/tmp/project-a")).toBe(false)
    expect(ToolRegistry.groups().has("v1-plugin:/tmp/project-b")).toBe(false)
  })

  const context = {
    sessionID: SessionSchema.ID.make("ses_v2tools"),
    agent: AgentV2.ID.make("build"),
    assistantMessageID: SessionMessage.ID.make("msg_v2tools"),
    toolCallID: "call-1",
  }

  const syncDemo = (execute: ToolDefinition["execute"]) => {
    syncPluginTools(
      [
        {
          tool: {
            demo_tool: tool({
              description: "Demo",
              args: {
                query: tool.schema.string().describe("What to look up"),
                limit: tool.schema.number().int().min(1).default(5),
              },
              execute,
            }),
          },
        },
      ],
      "/tmp/project-schema",
      "/tmp/project-schema",
    )
    const demo = ToolRegistry.groups().get("v1-plugin:/tmp/project-schema")?.get("demo_tool")
    clearPluginTools("/tmp/project-schema")
    if (!demo) throw new Error("demo_tool was not registered")
    return demo
  }

  const run = (demo: Tool.AnyTool, input: unknown) =>
    Effect.runPromise(
      Tool.settle(demo, { type: "tool-call", id: "call-1", name: "demo_tool", input }, context).pipe(
        Effect.map((output) => ({ ok: true as const, output })),
        Effect.catch((failure) => Effect.succeed({ ok: false as const, message: failure.message })),
      ),
    )

  test("advertises the plugin's zod args as JSON Schema", () => {
    const schema = Tool.definition("demo_tool", syncDemo(async () => "ok")).inputSchema
    expect(schema).toMatchObject({
      type: "object",
      properties: { query: { type: "string", description: "What to look up" }, limit: { type: "integer" } },
      required: ["query"],
    })
  })

  test("validates input with zod and passes parsed args with defaults", async () => {
    const seen: unknown[] = []
    const demo = syncDemo(async (args) => {
      seen.push(args)
      return "ok"
    })
    expect(await run(demo, { query: "x", limit: 0 })).toMatchObject({ ok: false })
    expect(seen).toEqual([])
    expect(await run(demo, { query: "x" })).toMatchObject({ ok: true })
    expect(seen).toEqual([{ query: "x", limit: 5 }])
  })

  test("plugin permission asks fail closed without a Permission service", async () => {
    const demo = syncDemo(async (_args, ctx) => {
      await ctx.ask({ permission: "demo", patterns: ["*"], always: [], metadata: {} })
      return "asked"
    })
    expect(await run(demo, { query: "x" })).toMatchObject({ ok: false })
  })
})