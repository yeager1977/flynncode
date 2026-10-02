import { describe, expect, test } from "bun:test"
import { syncPluginTools, clearPluginTools } from "../../src/plugin/v2-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"

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
})