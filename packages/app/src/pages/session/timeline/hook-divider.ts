import type { Part, TextPart } from "@flynncode/sdk/v2"

// A Stop hook's continuation is a synthetic prompt whose text part carries the
// hook event and its reason in metadata; the divider shows the reason's first
// line.
export function hookContinuation(parts: Part[]) {
  const metadata = parts.find((part): part is TextPart => part.type === "text" && part.synthetic === true)?.metadata
  const event = metadata?.["hook"]
  const reason = metadata?.["reason"]
  if (typeof event !== "string" || typeof reason !== "string") return {}
  const line = reason.trim().split("\n")[0]?.trim() ?? ""
  if (line === "") return {}
  return { hookEvent: event, hookReason: line.length > 160 ? `${line.slice(0, 159)}…` : line }
}
