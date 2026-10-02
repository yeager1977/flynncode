export type Citation = {
  path: string
  line?: number
}

// Requires at least one path separator so display text like "bun.sh" does not
// match; a leading @ acts as a mention boundary (@src/index.ts) and is dropped.
const pattern =
  /(?:^|[\s("'@])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]+)(?::(\d+))?(?::\d+)?/

export function citationFromText(text: string): Citation | undefined {
  const match = pattern.exec(text.trim())
  const path = match?.[1]
  if (!path || path.startsWith("http")) return
  const line = match[2] ? Number(match[2]) : undefined
  return { path, ...(line ? { line } : {}) }
}

export function citationFromTarget(target: EventTarget | null): Citation | undefined {
  if (!(target instanceof Element)) return
  const node = target.closest("a, code, [data-path]")
  if (!node) return
  if (node instanceof HTMLAnchorElement && node.hash.startsWith("#L")) {
    // Skip external hosts (github.com etc.): they reuse the #L hash convention
    // but their pathname is a remote path, never a local file.
    if (node.hostname && URL.parse(node.href)?.origin !== window.location.origin) return
    const line = Number(node.hash.slice(2))
    const path = node.pathname.replace(/^\//, "") || node.textContent || ""
    return citationFromText(line ? `${path}:${line}` : path)
  }
  const marked = node.getAttribute("data-path")
  // data-path is an explicit app-set file marker; it bypasses the text
  // heuristic so root-level files without a path separator still resolve.
  if (marked) return { path: marked }
  return citationFromText(node.textContent ?? "")
}

/** Center the cited review line once its diff row renders; polls like the comment focus scroll. */
export function scrollCitationLine(line: number | undefined, attempt = 0): void {
  if (line === undefined || attempt >= 120) return
  requestAnimationFrame(() => {
    const root = document.querySelector('[data-slot="session-review-v2-diff-scroll"]')
    const row = root?.querySelector(`[data-line="${line}"]`)
    if (!(row instanceof HTMLElement) || !(root instanceof HTMLElement)) {
      scrollCitationLine(line, attempt + 1)
      return
    }
    const box = root.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    root.scrollTop = Math.max(0, root.scrollTop + (rowBox.top - box.top) - box.height / 2 + rowBox.height / 2)
  })
}
