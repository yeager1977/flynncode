export * as ProjectFolders from "./folders"

import path from "path"
import { FSUtil } from "../fs-util"
import { AbsolutePath } from "../schema"

export const MaxExtras = 8

export function normalizeFolders(primary: string, extras: string[]): string[] {
  const base = AbsolutePath.make(FSUtil.normalizePath(primary))
  const seen = new Set<string>([base])
  const out: string[] = []
  for (const item of extras) {
    const normalized = FSUtil.normalizePath(item)
    if (!path.isAbsolute(normalized)) continue
    const absolute = AbsolutePath.make(normalized)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    out.push(absolute)
  }
  return out
}

export function isAttached(filepath: string, primary: string, extras: string[]): boolean {
  if (FSUtil.contains(primary, filepath)) return true
  for (const root of extras) {
    if (FSUtil.contains(root, filepath)) return true
  }
  return false
}

export function promoteToPrimary(folders: string[], nextPrimary: string): { primary: string; extras: string[] } {
  const rest = folders.filter((item) => item !== nextPrimary)
  return { primary: nextPrimary, extras: rest }
}
