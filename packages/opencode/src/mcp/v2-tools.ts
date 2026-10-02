import { ToolFailure } from "@opencode-ai/llm"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { CallToolResultSchema, type Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect, Schema } from "effect"
import { toolName } from "./catalog"

export const clearV2Tools = (server: string) => {
  ToolRegistry.clearSupplements(server)
}

export const syncV2Tools = (server: string, client: Client, defs: readonly MCPToolDef[], timeout?: number) => {
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
  ToolRegistry.replaceSupplements(server, tools)
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