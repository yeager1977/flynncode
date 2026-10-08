export * as ProjectFolders from "./folders"

export function normalizeFolders(primary: string, extras: string[]): string[] {
  const seen = new Set<string>([primary])
  const out: string[] = []
  for (const item of extras) {
    if (!item.startsWith("/")) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

export function isAttached(filepath: string, primary: string, extras: string[]): boolean {
  if (filepath === primary || filepath.startsWith(primary + "/")) return true
  for (const root of extras) {
    if (filepath === root || filepath.startsWith(root + "/")) return true
  }
  return false
}

export function promoteToPrimary(folders: string[], nextPrimary: string): { primary: string; extras: string[] } {
  const rest = folders.filter((item) => item !== nextPrimary)
  return { primary: nextPrimary, extras: rest }
}
