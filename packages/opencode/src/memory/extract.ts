import type { SessionV1 } from "@opencode-ai/core/v1/session"

export function shouldExtract(input: { messages: SessionV1.WithParts[]; min_turns: number }) {
  const turns = input.messages.filter(
    (msg) => msg.info.role === "user" && !msg.parts.some((part) => part.type === "compaction"),
  )
  return turns.length >= input.min_turns
}

export function buildExtractionPrompt(input: { conversation: string }) {
  return [
    "Extract durable working conventions worth remembering across sessions (tool preferences, repo conventions, user habits).",
    "Rules: never include secrets, tokens, passwords, private keys, credentials, or personal data. If nothing durable is present, reply with exactly: NOTHING TO REMEMBER.",
    "Keep it under 10 short markdown bullets.",
    "Conversation:",
    input.conversation,
  ].join("\n\n")
}

export * as MemoryExtract from "./extract"
