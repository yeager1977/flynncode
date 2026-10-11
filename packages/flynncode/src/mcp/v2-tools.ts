import { ToolFailure } from "@flynncode/llm"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { CallToolResultSchema, type Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { ToolRegistry } from "@flynncode/core/tool/registry"
import { Tool } from "@flynncode/core/tool/tool"
import { Effect, Schema } from "effect"
import { toolName } from "./catalog"

// Supplements are owned per directory: two instances can connect to an MCP
// server with the same name, and one closing must not drop the other's tools.
export const owner = (directory: string, server: string) => `v1-mcp:${directory}:${server}`

export const clearV2Tools = (directory: string, server: string): Effect.Effect<void> => {
  // A no-op when the server never registered or was already cleared.
  ToolRegistry.clearSupplements(owner(directory, server))
  return Effect.void
}

export const syncV2Tools = (
  directory: string,
  server: string,
  client: Client,
  defs: readonly MCPToolDef[],
  timeout?: number,
) => {
  const tools: Record<string, Tool.AnyTool> = {}
  for (const def of defs) {
    tools[toolName(server, def.name)] = Tool.make({
      description: [def.description ?? def.name, JSON.stringify(def.inputSchema)].filter(Boolean).join("\n"),
      input: Schema.Unknown,
      output: Schema.String,
      execute: (input) =>
        Effect.tryPromise({
          try: () => call(client, def.name, input, timeout),
          catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
        }),
    })
  }
  ToolRegistry.replaceSupplements(owner(directory, server), tools, directory)
}

async function call(client: Client, name: string, input: unknown, timeout?: number) {
  const result = await client.callTool(
    { name, arguments: input && typeof input === "object" ? (input as Record<string, unknown>) : {} },
    CallToolResultSchema,
    { timeout, resetTimeoutOnProgress: true, onprogress: () => {} },
  )
  if (result.isError) {
    throw new Error(
      result.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .filter((text) => text.trim())
        .join("\n\n") || "MCP tool returned an error",
    )
  }
  const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
  return text || JSON.stringify(result.structuredContent ?? {})
}