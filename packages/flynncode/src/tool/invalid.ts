import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

/** The repair hint for a call to a deferred MCP tool that mcp_tool_search has not loaded. */
export const notLoaded = (tool: string) =>
  `Tool ${tool} is not loaded. Load it first with mcp_tool_search (query: "select:${tool}"), then call it again.`

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Invalid Tool",
        // An unloaded deferred tool is not an argument problem, so its hint stands alone. The
        // parameters stay unchanged because runtimes that send every tool would send them too.
        output:
          params.error === notLoaded(params.tool)
            ? params.error
            : `The arguments provided to the tool are invalid: ${params.error}`,
        metadata: {},
      }),
  }),
)
