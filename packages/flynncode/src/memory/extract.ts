import type { SessionV1 } from "@flynncode/core/v1/session"

export function shouldExtract(input: { messages: SessionV1.WithParts[]; min_turns: number }) {
  const turns = input.messages.filter(
    (msg) => msg.info.role === "user" && !msg.parts.some((part) => part.type === "compaction"),
  )
  return turns.length >= input.min_turns
}

const MAX_EXISTING_CHARS_PER_TOPIC = 800
const MAX_EXISTING_CHARS = 12_000

export function buildExtractionPrompt(input: {
  conversation: string
  existing?: readonly { slug: string; text: string }[]
}) {
  const existing = input.existing ?? []
  return [
    "Extract durable working conventions worth remembering across sessions (tool preferences, repo conventions, user habits).",
    "Rules: never include secrets, tokens, passwords, private keys, credentials, or personal data.",
    "Output format: one or more topic blocks, each block exactly:",
    "SLUG: <kebab-topic-name>",
    "- <bullet line>",
    "A slug is lowercase letters, digits, and dashes, one theme per slug, at most 5 blocks, 1-3 short bullets per block. Never reuse a slug for two themes.",
    ...(existing.length
      ? [
          "Existing topics are listed below. When a fact fits an existing topic, use that exact slug; mint a new slug only when no existing topic fits. Bullets for an existing slug are appended to it, so output only facts it does not already state.",
          "Existing topics:",
          renderExisting(existing),
        ]
      : []),
    "Each bullet must state a concrete, specific fact. Never output placeholder or filler bullets such as 'temporary note', 'project convention', or 'TODO'.",
    "If nothing durable and new is present, reply with exactly: NOTHING TO REMEMBER.",
    "Conversation:",
    input.conversation,
  ].join("\n\n")
}

// Every slug stays visible so the model can reuse it; topic bodies share a
// budget so a large memories dir cannot crowd out the conversation.
function renderExisting(existing: readonly { slug: string; text: string }[]) {
  const rendered = existing.reduce(
    (acc, topic) => {
      const body = topic.text
        .trim()
        .slice(0, Math.max(0, Math.min(MAX_EXISTING_CHARS_PER_TOPIC, MAX_EXISTING_CHARS - acc.used)))
      return {
        used: acc.used + body.length,
        blocks: [...acc.blocks, body ? `SLUG: ${topic.slug}\n${body}` : `SLUG: ${topic.slug}`],
      }
    },
    { used: 0, blocks: [] as string[] },
  )
  return rendered.blocks.join("\n\n")
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

// Turns parsed topics into full replacement texts for the memories dir. A
// topic that restates an existing one folds into it, bullets the dir already
// states or that carry no meaning are dropped, and surviving bullets are
// appended to the existing topic body rather than replacing it. `room` is how
// many new topic files may still be created before load() hits max_files.
export function curateTopics(input: {
  topics: readonly { slug: string; text: string }[]
  existing: readonly { slug: string; text: string }[]
  room: number
}) {
  const index = input.existing.map((topic) => ({
    slug: topic.slug,
    words: terms(`${topic.slug.replaceAll("-", " ")}\n${topic.text}`),
  }))
  const weight = idf(index.map((topic) => topic.words))
  const known = input.existing.flatMap((topic) => topic.text.split("\n")).map(terms)
  const curated = new Map<string, string[]>()
  for (const topic of input.topics) {
    const slug = route(
      topic,
      index,
      weight,
      input.room - [...curated.keys()].filter((key) => !index.some((item) => item.slug === key)).length,
    )
    if (!slug) continue
    const bullets = topic.text.split("\n").filter((bullet) => {
      const words = terms(bullet)
      if (isPlaceholder(bullet, words)) return false
      if (known.some((line) => overlap(words, line, weight) >= COVERED)) return false
      known.push(words)
      return true
    })
    if (bullets.length) curated.set(slug, [...(curated.get(slug) ?? []), ...bullets])
  }
  return [...curated].map(([slug, bullets]) => {
    const base = input.existing.find((topic) => topic.slug === slug)?.text.trimEnd()
    return { slug, text: [...(base ? [base] : []), ...bullets].join("\n") }
  })
}

// Share of a topic's (IDF-weighted) words an existing topic must contain for
// the topic to fold into it; calibrated on the 2026-11-01 sprawl corpus, where
// true restatements scored 0.5-1.0 and distinct themes stayed below.
const ROUTE = 0.5
// Share of a bullet's weighted words a single existing line must contain for
// the bullet to count as already remembered.
const COVERED = 0.8

// Picks the slug a topic lands in: its own slug when it exists, an existing
// slug it is a word-subset or superset of (mobile-connector-target ->
// mobile-connector), or the existing topic covering most of its content.
// With no match it keeps its new slug while there is room under max_files,
// and junk slugs (tmp-key, other) are rejected outright.
function route(
  topic: { slug: string; text: string },
  index: readonly { slug: string; words: ReadonlySet<string> }[],
  weight: (word: string) => number,
  room: number,
) {
  if (index.some((item) => item.slug === topic.slug)) return topic.slug
  const words = slugTerms(topic.slug)
  const named = index
    .map((item) => ({ slug: item.slug, words: slugTerms(item.slug) }))
    .filter((item) => item.words.size > 0 && words.size > 0)
    .filter(
      (item) => [...item.words].every((word) => words.has(word)) || [...words].every((word) => item.words.has(word)),
    )
    .toSorted((a, b) => b.words.size - a.words.size || a.slug.localeCompare(b.slug))[0]
  if (named) return named.slug
  const content = terms(`${topic.slug.replaceAll("-", " ")}\n${topic.text}`)
  const best = index
    .map((item) => ({ slug: item.slug, score: overlap(content, item.words, weight) }))
    .toSorted((a, b) => b.score - a.score)[0]
  if (best && best.score >= ROUTE) return best.slug
  if ([...words].every((word) => JUNK_SLUG.has(word))) return undefined
  if (room > 0) return topic.slug
  // At max_files a new file would never be loaded; fold into the closest topic.
  if (best && best.score > 0) return best.slug
  return undefined
}

function slugTerms(slug: string) {
  return new Set(
    slug
      .split("-")
      .map(stem)
      .filter((word) => word && !STOPWORDS.has(word)),
  )
}

const JUNK_SLUG = new Set("tmp temp scratch misc other untitled placeholder topic note key test foo bar baz".split(" "))

// Words that carry no meaning on their own: a bullet made only of these is
// filler ("temporary note", "project convention", "user preferences").
const FILLER = new Set(
  "temporary temp tmp note project convention todo tbd placeholder misc miscellaneous other general info information memory topic remember nothing none example sample test stuff thing detail something various preference habit workflow item entry key value data text content fact durable important user setting update new lorem ipsum foo bar baz".split(
    " ",
  ),
)

function isPlaceholder(bullet: string, words: ReadonlySet<string>) {
  if (!/[a-z0-9]/i.test(bullet)) return true
  return [...words].every((word) => FILLER.has(word))
}

// Weighted share of `words` that `other` contains. Rare words dominate, so a
// shared "bun" or "mobile" counts for more than a shared "fix". Polarity words
// (never/always/not) stay terms, so "never use X" is not mistaken for
// "always use X".
function overlap(words: ReadonlySet<string>, other: ReadonlySet<string>, weight: (word: string) => number) {
  const total = [...words].reduce((sum, word) => sum + weight(word), 0)
  if (total === 0) return 0
  return [...words].filter((word) => other.has(word)).reduce((sum, word) => sum + weight(word), 0) / total
}

function idf(docs: readonly ReadonlySet<string>[]) {
  const counts = new Map<string, number>()
  docs.forEach((doc) => doc.forEach((word) => counts.set(word, (counts.get(word) ?? 0) + 1)))
  return (word: string) => Math.log((docs.length + 1) / ((counts.get(word) ?? 0) + 0.5))
}

const STOPWORDS = new Set(
  "a an and are as at be been but by can do for from has have if in into is it its of on or so than that the then there these this those to was were when where which while who will with you your".split(
    " ",
  ),
)

function terms(text: string) {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem).filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  )
}

function stem(word: string) {
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

export * as MemoryExtract from "./extract"
