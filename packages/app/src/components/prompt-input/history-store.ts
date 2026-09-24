import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { Prompt } from "@/context/prompt"
import type { Platform } from "@/context/platform"
import { Persist, persisted, type PersistTarget } from "@/utils/persist"
import {
  clonePromptHistoryComments,
  clonePromptParts,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryStoredEntry,
} from "./history"

export type PromptInputHistory = {
  entries: (mode: "normal" | "shell") => PromptHistoryStoredEntry[]
  add: (prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[]) => void
}

type PromptHistoryState = { entries: PromptHistoryStoredEntry[] }

function createPromptInputHistoryStore(
  normal: Store<PromptHistoryState>,
  setNormal: SetStoreFunction<PromptHistoryState>,
  shell: Store<PromptHistoryState>,
  setShell: SetStoreFunction<PromptHistoryState>,
): PromptInputHistory {
  return {
    entries: (mode) => (mode === "shell" ? shell.entries : normal.entries),
    add(prompt, mode, comments) {
      const current = mode === "shell" ? shell : normal
      const setCurrent = mode === "shell" ? setShell : setNormal
      const next = prependHistoryEntry(current.entries, prompt, comments)
      if (next === current.entries) return
      setCurrent("entries", next)
    },
  }
}

export function createPromptInputHistory(): PromptInputHistory {
  const [normal, setNormal] = createStore<PromptHistoryState>({ entries: [] })
  const [shell, setShell] = createStore<PromptHistoryState>({ entries: [] })
  return createPromptInputHistoryStore(normal, setNormal, shell, setShell)
}

export function createPersistedPromptInputHistory(target?: PersistTarget, platformOverride?: Platform) {
  const normalTarget = target
    ? Persist.prompt({ ...target, key: `${target.key}-normal` })
    : Persist.prompt(Persist.global("prompt-history", ["prompt-history.v1"]))
  const shellTarget = target
    ? Persist.prompt({ ...target, key: `${target.key}-shell` })
    : Persist.prompt(Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]))
  const [normal, setNormal, normalInit] = persisted(
    normalTarget,
    createStore<PromptHistoryState>({ entries: [] }),
    platformOverride,
  )
  const [shell, setShell, shellInit] = persisted(
    shellTarget,
    createStore<PromptHistoryState>({ entries: [] }),
    platformOverride,
  )
  const history = createPromptInputHistoryStore(normal, setNormal, shell, setShell)
  return {
    ...history,
    add(prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[]) {
      const ready = mode === "shell" ? shellInit : normalInit
      if (!(ready instanceof Promise)) return history.add(prompt, mode, comments)
      const saved = clonePromptParts(prompt)
      const metadata = clonePromptHistoryComments(comments)
      void ready.then(() => history.add(saved, mode, metadata))
    },
  }
}
