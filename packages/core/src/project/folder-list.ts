// Shared with the desktop renderer, so this must not import node builtins:
// the renderer bundle stubs them as empty modules.

export const MaxExtras = 8

export function normalizeFolders(primary: string, extras: string[]): string[] {
  const seen = new Set<string>([normalizeAbsolute(primary) ?? primary])
  return extras.flatMap((item) => {
    const absolute = normalizeAbsolute(item)
    if (!absolute || seen.has(absolute)) return []
    seen.add(absolute)
    return [absolute]
  })
}

export function promoteToPrimary(folders: string[], nextPrimary: string): { primary: string; extras: string[] } {
  const rest = folders.filter((item) => item !== nextPrimary)
  return { primary: nextPrimary, extras: rest }
}

// Lexical equivalent of path.resolve for absolute POSIX, drive-letter and UNC
// paths; returns undefined for relative input.
function normalizeAbsolute(input: string) {
  const windows = /^([a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/]+[^\\/]+)/.exec(input)
  if (!windows && !input.startsWith("/")) return undefined
  const root = windows ? windows[1].replace(/\//g, "\\").replace(/\\+$/, "") + "\\" : "/"
  const segments = input
    .slice(windows ? windows[1].length : 0)
    .split(windows ? /[\\/]+/ : /\/+/)
    .reduce<string[]>((acc, segment) => {
      if (!segment || segment === ".") return acc
      if (segment === "..") return acc.slice(0, -1)
      return [...acc, segment]
    }, [])
  return root + segments.join(windows ? "\\" : "/")
}
