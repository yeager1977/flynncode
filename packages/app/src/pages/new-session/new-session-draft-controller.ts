import { useSearchParams } from "@solidjs/router"
import { createEffect, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { usePromptInputV2Controller } from "@/components/prompt-input-v2"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { createPromptInputController, createPromptProjectControls } from "@/pages/session/composer"
import { createPromptModelSelection } from "@/pages/session/composer/prompt-model-selection"
import { useSessionKey } from "@/pages/session/session-layout"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { showToast } from "@/utils/toast"
import { foldersConnection, setSessionExtras } from "@/utils/session-folders-api"

export function createNewSessionDraftController(workspace: {
  worktree: () => string
  resetWorktree: () => void
  extraFolders: () => readonly string[]
  resetExtraFolders: () => void
}) {
  const prompt = usePrompt()
  const serverSync = useServerSync()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const comments = useComments()
  const local = useLocal()
  const route = useSessionKey()
  const [searchParams, setSearchParams] = useSearchParams<{ draftId?: string; prompt?: string; draftKind?: string }>()
  const model = createPromptModelSelection({ agent: () => local.agent.current() })

  useComposerCommands({ model })

  const controls = createPromptInputController({
    sessionKey: route.sessionKey,
    sessionID: () => route.params.id,
    queryOptions: serverSync().queryOptions,
    model,
  })
  const projectControls = createPromptProjectControls()
  const input = usePromptInputV2Controller({
    get controls() {
      return controls()
    },
    get newSessionWorktree() {
      return workspace.worktree()
    },
    onNewSessionWorktreeReset: workspace.resetWorktree,
    get newSessionExtraFolders() {
      return workspace.extraFolders()
    },
    onNewSessionExtraFoldersReset: workspace.resetExtraFolders,
    onNewSessionCreated: async (session) => {
      // Multifold: extras picked on the new-session view attach after
      // create. The primary directory stays the placement key.
      const extras = workspace.extraFolders().filter((dir) => dir !== session.directory)
      if (extras.length === 0) return
      const conn = foldersConnection(server.current, platform.fetch)
      const attached = conn ? await setSessionExtras(conn, session.id, extras) : undefined
      if (!attached) showToast({ title: language.t("common.requestFailed") })
    },
    onSubmit: comments.clear,
  })

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [kindState, setKindState] = createStore<{ kind: "code" | "knowledge" }>({
    kind: searchParams.draftKind === "knowledge" ? "knowledge" : "code",
  })

  const applyKindAgent = () => {
    const current = local.agent.current()?.name
    if (kindState.kind === "knowledge") {
      if (current !== "knowledge" && local.agent.list().some((item) => item.name === "knowledge"))
        local.agent.set("knowledge")
      return
    }
    if (current === "knowledge" && local.agent.list().some((item) => item.name === "build")) local.agent.set("build")
  }

  function setKind(next: "code" | "knowledge") {
    if (kindState.kind === next) return
    setKindState("kind", next)
    applyKindAgent()
    setSearchParams({ ...searchParams, draftKind: next === "knowledge" ? "knowledge" : undefined })
  }

  let kindAgentSeeded = false
  createEffect(() => {
    if (kindAgentSeeded) return
    if (local.agent.list().length === 0) return
    untrack(() => {
      applyKindAgent()
      kindAgentSeeded = true
    })
  })

  return {
    input,
    kind: () => kindState.kind,
    setKind,
    prompt: {
      ready: prompt.ready,
      readyPromise: () => prompt.ready.promise,
    },
    project: {
      controls: projectControls,
    },
  }
}

export type NewSessionDraftController = ReturnType<typeof createNewSessionDraftController>
