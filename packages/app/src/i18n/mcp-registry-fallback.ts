import { dict } from "./en"

// MCP registry translations are pending. Locale entries override this Locale entries override this
// explicit English fallback as verified translations become available.
export const mcpRegistryFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("settings.mcp.form.scope.") || key.startsWith("settings.mcp.registry.")),
)
