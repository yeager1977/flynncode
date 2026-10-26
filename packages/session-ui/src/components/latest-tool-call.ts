import type { Message, Part, ToolPart } from "@flynncode/sdk/v2"

// The call ID of a session's most recent call to `tool`, in message order.
export function latestToolCall(
  messages: readonly Message[],
  parts: Record<string, readonly Part[] | undefined>,
  tool: string,
) {
  return messages
    .flatMap((message) => parts[message.id] ?? [])
    .findLast((part): part is ToolPart => part.type === "tool" && part.tool === tool)?.callID
}
