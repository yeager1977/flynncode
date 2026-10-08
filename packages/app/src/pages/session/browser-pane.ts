const loopbackHost = (hostname: string) => {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true
  return false
}

export function isLocalPreviewUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return loopbackHost(url.hostname)
}

export function normalizePreviewUrl(value: string, fallback: string): string {
  const trimmed = value.trim()
  const candidate = trimmed.includes("://") ? trimmed : `http://${trimmed}`
  if (!URL.canParse(candidate)) return fallback
  const url = new URL(candidate)
  if (url.protocol !== "http:" && url.protocol !== "https:") return fallback
  return url.href
}

// The pane URL persists per session in this module-level record (keyed by
// session id, falling back to the project directory). It is never written to
// localStorage: switching sessions restores each session's URL while
// unmounting or reloading the app clears the record.
const urls: Record<string, string> = {}

export function browserPaneUrlFor(key: string, fallback: string): string {
  return urls[key] ?? fallback
}

export function setBrowserPaneUrl(key: string, url: string) {
  urls[key] = url
}

export function clearBrowserPaneUrlsForTests() {
  for (const key of Object.keys(urls)) delete urls[key]
}
