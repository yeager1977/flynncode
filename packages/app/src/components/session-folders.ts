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
