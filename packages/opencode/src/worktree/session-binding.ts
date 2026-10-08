import path from "node:path"

export type Binding = {
  sessionID: string
  directory: string
  disposable: boolean
}

export function bindingKey(sessionID: string, directory: string): string {
  return `${sessionID}::${directory}`
}

export function shouldDispose(binding: Binding, opts: { archived: boolean; running: boolean }): boolean {
  return binding.disposable && opts.archived && !opts.running
}

export function displayName(directory: string, _projectRoot: string): string {
  const base = path.basename(directory)
  if (base) return base
  return directory
}
