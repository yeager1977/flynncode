import type { SessionV1 } from "@flynncode/core/v1/session"

export function shouldExtract(input: { messages: SessionV1.WithParts[]; min_turns: number }) {
  const turns = input.messages.filter(
    (msg) => msg.info.role === "user" && !msg.parts.some((part) => part.type === "compaction"),
  )
  return turns.length >= input.min_turns
}

export function buildExtractionPrompt(input: { conversation: string }) {
  return [
    "Extract durable working conventions worth remembering across sessions (tool preferences, repo conventions, user habits).",
    "Rules: never include secrets, tokens, passwords, private keys, credentials, or personal data.",
    "Output format: one or more topic blocks, each block exactly:",
    "SLUG: <kebab-topic-name>",
    "- <bullet line>",
    "A slug is lowercase letters, digits, and dashes, one theme per slug, at most 5 blocks, 1-3 short bullets per block. Never reuse a slug for two themes.",
    "If nothing durable is present, reply with exactly: NOTHING TO REMEMBER.",
    "Conversation:",
    input.conversation,
  ].join("\n\n")
}

const MAX_TOPIC_BLOCKS = 5
const MAX_SLUG_LENGTH = 64

function normalizeSlug(raw: string) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
}

// Parses the SLUG:/bullet block contract emitted by buildExtractionPrompt.
// Blocks without bullets are dropped; duplicate slugs merge into the first.
export function parseExtractionTopics(text: string) {
  const blocks: Array<{ slug: string; body: string[] }> = []
  let current: { slug: string; body: string[] } | undefined
  for (const line of text.split("\n")) {
    if (/^SLUG:/i.test(line)) {
      const slug = normalizeSlug(line.slice("SLUG:".length).trim())
      if (!slug) {
        current = undefined
        continue
      }
      const existing = blocks.find((block) => block.slug === slug)
      current = existing ?? { slug, body: [] }
      if (!existing) blocks.push(current)
      continue
    }
    const bullet = line.trim().match(/^[-*]\s+(.+)$/)
    if (!bullet) continue
    current?.body.push(`- ${bullet[1].trim()}`)
  }
  return blocks
    .filter((block) => block.body.length > 0)
    .slice(0, MAX_TOPIC_BLOCKS)
    .map((block) => ({ slug: block.slug, text: block.body.join("\n") }))
}

export * as MemoryExtract from "./extract"
