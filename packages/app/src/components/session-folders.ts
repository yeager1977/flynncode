import { MaxExtras, normalizeFolders, promoteToPrimary } from "@opencode-ai/core/project/folder-list"

export const MaxSessionExtraFolders = MaxExtras

export function normalizeSessionFolders(primary: string, extras: readonly string[]): string[] {
  return normalizeFolders(primary, [...extras])
}

export function addSessionFolder(primary: string, extras: readonly string[], directory: string): string[] {
  const next = normalizeFolders(primary, [...extras, directory])
  if (next.length > MaxExtras) return [...extras]
  return next
}

export function removeSessionFolder(extras: readonly string[], directory: string): string[] {
  return extras.filter((item) => item !== directory)
}

export function promoteSessionFolder(
  primary: string,
  extras: readonly string[],
  nextPrimary: string,
): { primary: string; extras: string[] } {
  return promoteToPrimary([primary, ...extras], nextPrimary)
}

export function canAddSessionFolder(extras: readonly string[]): boolean {
  return extras.length < MaxExtras
}

// Plans attaching picked folders to an open session: already-attached picks
// are dropped (and reported), and the whole batch is rejected when it would
// exceed the extras limit so a partial attach never surprises the user.
export function appendSessionFolders(primary: string, extras: readonly string[], picked: readonly string[]) {
  const known = new Set([primary, ...extras])
  const fresh = [...new Set(picked)].filter((directory) => !known.has(directory))
  return {
    extras: [...extras, ...fresh],
    added: fresh.length,
    duplicate: fresh.length < picked.length,
    overLimit: extras.length + fresh.length > MaxExtras,
  }
}
