export * as ProjectFolders from "./folders"

import { FSUtil } from "../fs-util"
import { MaxExtras, normalizeFolders, promoteToPrimary } from "./folder-list"

export { MaxExtras, normalizeFolders, promoteToPrimary }

export function isAttached(filepath: string, primary: string, extras: string[]): boolean {
  if (FSUtil.contains(primary, filepath)) return true
  for (const root of extras) {
    if (FSUtil.contains(root, filepath)) return true
  }
  return false
}
