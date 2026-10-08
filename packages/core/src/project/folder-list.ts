import path from "node:path"

export const MaxExtras = 8

export function normalizeFolders(primary: string, extras: string[]): string[] {
  const base = path.resolve(primary)
  const seen = new Set<string>([base])
  const out: string[] = []
  for (const item of extras) {
    if (!path.isAbsolute(item)) continue
    const absolute = path.resolve(item)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    out.push(absolute)
  }
  return out
}

export function promoteToPrimary(folders: string[], nextPrimary: string): { primary: string; extras: string[] } {
  const rest = folders.filter((item) => item !== nextPrimary)
  return { primary: nextPrimary, extras: rest }
}
