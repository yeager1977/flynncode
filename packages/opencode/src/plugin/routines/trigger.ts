import { Glob } from "bun"
import path from "path"
import type { Routine } from "./parse"

export async function triggerDue(routine: Routine, directory: string) {
  const patterns = routine.trigger?.files
  if (!patterns || patterns.length === 0) return false
  const since = routine.lastRun ? new Date(routine.lastRun).getTime() : 0
  for (const pattern of patterns) {
    const glob = new Glob(pattern)
    for await (const entry of glob.scan({ cwd: directory, onlyFiles: true })) {
      const stat = await Bun.file(path.join(directory, entry)).stat().catch(() => undefined)
      if (stat && stat.mtime.getTime() > since) return true
    }
  }
  return false
}
