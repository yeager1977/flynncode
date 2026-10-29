import type { Message, Session, Part, SnapshotFileDiff, SessionStatus, Provider } from "@flynncode/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { createSimpleContext } from "@flynncode/ui/context"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, Provider>
  defaultModel?: {
    providerID: string
    modelID: string
  } | null
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: (SnapshotFileDiff | FileDiffInfo)[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export type ShellPromoteFn = (input: { sessionID: string; callID: string }) => Promise<void>

// Plan mode is client-side agent state, so the app owns whether it is on and how to leave it.
export type PlanModeControl = {
  active: () => boolean
  restore: (agent: string) => void
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    sessionID?: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onShellPromote?: ShellPromoteFn
    planMode?: PlanModeControl
    // Resolves a provider the connected list leaves out, such as one a past message used before it was removed.
    lookupProvider?: (providerID: string) => Provider | undefined
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      get sessionID() {
        return props.sessionID
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      promoteShell: props.onShellPromote,
      planMode: props.planMode,
      model(providerID: string, modelID: string) {
        return (
          props.data.provider?.all?.get(providerID)?.models?.[modelID] ??
          props.lookupProvider?.(providerID)?.models?.[modelID]
        )
      },
    }
  },
})
