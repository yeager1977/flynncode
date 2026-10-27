const MAX_NAMES = 5

export type ToolSearchCard =
  | { kind: "loaded"; count: number; names: string[]; more: number }
  | { kind: "none"; query: string }

/** Summarises a `tool_search` result (`metadata: { query, loaded }`) for the compact card. */
export function toolSearchCard(metadata: Record<string, unknown>, input: Record<string, unknown> = {}): ToolSearchCard {
  const loaded = Array.isArray(metadata.loaded)
    ? metadata.loaded.filter((id): id is string => typeof id === "string")
    : []
  if (loaded.length === 0) {
    const query = typeof metadata.query === "string" ? metadata.query : input.query
    return { kind: "none", query: typeof query === "string" ? query : "" }
  }
  return {
    kind: "loaded",
    count: loaded.length,
    names: loaded.slice(0, MAX_NAMES),
    more: Math.max(0, loaded.length - MAX_NAMES),
  }
}
