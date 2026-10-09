import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { MachineSyncPlatform, MachineSyncStatus } from "@/context/machine-sync-types"
import { pathKey } from "@/utils/path-key"

// A chat synced from the other computer may point at a folder that does not
// exist here; it stays readable, but tools would fail in it. Both sides go
// through pathKey so trailing slashes and Windows separators do not matter.
export function isFolderMissing(missingDirectories: readonly string[] | undefined, directory: string | undefined) {
  if (!directory || !missingDirectories) return false
  const key = pathKey(directory)
  return missingDirectories.some((missing) => pathKey(missing) === key)
}

export function createFolderMissing(input: {
  api: MachineSyncPlatform | undefined
  directory: () => string | undefined
}) {
  const [status, setStatus] = createSignal<MachineSyncStatus>()
  onMount(() => {
    const api = input.api
    if (!api) return
    void api
      .status()
      .then((current) => setStatus(current))
      .catch(() => undefined)
    onCleanup(api.subscribe((current) => setStatus(current)))
  })
  return createMemo(() => isFolderMissing(status()?.missingDirectories, input.directory()))
}
