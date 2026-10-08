import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import {
  MaxSessionExtraFolders,
  addSessionFolder,
  normalizeSessionFolders,
  promoteSessionFolder,
  removeSessionFolder,
} from "@/components/session-folders"

export { MaxSessionExtraFolders, addSessionFolder, normalizeSessionFolders, promoteSessionFolder, removeSessionFolder }

const workspaceBarEnabled = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"

export function resolveNewSessionWorktree(input: {
  enabled: boolean
  selected?: string
  directory: string
  projectWorktree?: string
}) {
  if (!input.enabled) return "main"
  if (input.selected) return input.selected
  if (input.projectWorktree && input.directory !== input.projectWorktree) return input.directory
  return "main"
}

export function normalizeNewSessionWorktree(value: string, directory: string, projectWorktree?: string) {
  if (value === "main" && projectWorktree !== directory) return projectWorktree
  if (value === "disposable") return "disposable"
  return value
}

export function resolveNewSessionBranch(input: {
  worktree: string
  local?: string
  worktreeBranch: (worktree: string) => string | undefined
}) {
  if (input.worktree === "main" || input.worktree === "create" || input.worktree === "disposable") return input.local
  return input.worktreeBranch(input.worktree) ?? input.local
}

export function createNewSessionWorkspaceController() {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const [worktree, setWorktree] = createSignal<string>()
  const visible = createMemo(() => workspaceBarEnabled && sync().project?.vcs === "git")
  const value = createMemo(() =>
    resolveNewSessionWorktree({
      enabled: visible(),
      selected: worktree(),
      directory: sdk().directory,
      projectWorktree: sync().project?.worktree,
    }),
  )
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const localBranch = createMemo(() => serverSync().child(projectRoot())[0].vcs?.branch)
  const branch = createMemo(() =>
    resolveNewSessionBranch({
      worktree: value(),
      local: localBranch(),
      worktreeBranch: (worktree) => serverSync().child(worktree)[0].vcs?.branch,
    }),
  )
  const disposable = createMemo(() => value() === "disposable")

  // Multifold: extra folders attached at session create. The draft's project
  // folder is primary unless another folder is promoted; the primary owns the
  // repository, AGENTS.md, and config while extras only widen file access.
  const [folderState, setFolderState] = createStore<{ primary?: string; extras: string[] }>({ extras: [] })
  const primary = () => folderState.primary ?? sdk().directory
  const folders = {
    primary,
    /** Set only when a folder other than the draft's project was promoted. */
    primaryOverride: () => folderState.primary,
    extras: () => folderState.extras,
    add: (directory: string) => setFolderState("extras", (current) => addSessionFolder(primary(), current, directory)),
    remove: (directory: string) => setFolderState("extras", (current) => removeSessionFolder(current, directory)),
    setPrimary: (directory: string) => {
      const next = promoteSessionFolder(primary(), folderState.extras, directory)
      setFolderState({ primary: next.primary === sdk().directory ? undefined : next.primary, extras: next.extras })
    },
    reset: () => setFolderState({ primary: undefined, extras: [] }),
  }

  return {
    folders,
    selection: {
      value,
      reset: () => setWorktree(),
      set: (worktree: string) =>
        setWorktree(normalizeNewSessionWorktree(worktree, sdk().directory, sync().project?.worktree)),
    },
    disposable,
    project: {
      root: projectRoot,
      workspaces: () => sync().project?.sandboxes ?? [],
      git: () => sync().project?.vcs === "git",
    },
    bar: {
      visible,
      branch,
    },
  }
}

export type NewSessionWorkspaceController = ReturnType<typeof createNewSessionWorkspaceController>
