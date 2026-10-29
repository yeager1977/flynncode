import { checksum } from "@flynncode/core/util/encode"
import DOMPurify from "dompurify"
import { parseMarkdown } from "./markdown-worker"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

// Finished blocks are kept by size, not count, so re-mounted rows of a long session find their sanitized HTML
// instead of falling back to plain text. Sizes count two bytes per UTF-16 code unit.
export const markdownCacheBytes = 16 * 1024 * 1024
const cache = new Map<string, MarkdownCacheEntry>()
const usage = { bytes: 0 }
const size = (key: string, value: MarkdownCacheEntry) =>
  (key.length + value.raw.length + value.hash.length + value.html.length) * 2
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

export function sanitizeMarkdown(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

export function getCachedMarkdown(key: string) {
  return cache.get(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  const previous = cache.get(key)
  if (previous) {
    cache.delete(key)
    usage.bytes -= size(key, previous)
  }
  const next = size(key, value)
  if (next > markdownCacheBytes) return
  cache.set(key, value)
  usage.bytes += next
  // Map order is insertion order and a touch re-inserts, so the first entries are the least recently used.
  for (const [oldest, entry] of cache) {
    if (usage.bytes <= markdownCacheBytes) return
    cache.delete(oldest)
    usage.bytes -= size(oldest, entry)
  }
}

export async function preloadMarkdown(text: string, cacheKey: string) {
  const key = `${cacheKey}:0:full`
  const cached = getCachedMarkdown(key)
  if (cached?.raw === text) {
    touchCachedMarkdown(key, cached)
    return
  }
  const hash = checksum(text)
  if (!hash) return
  touchCachedMarkdown(key, {
    raw: text,
    hash,
    html: sanitizeMarkdown(await parseMarkdown(text)),
  })
}
