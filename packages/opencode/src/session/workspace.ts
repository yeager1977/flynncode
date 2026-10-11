import { Context, Effect } from "effect"
import { SessionFolders } from "@opencode-ai/core/session/folders"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "./schema"

// The instance's folder union is for observation. Only a prompt/tool scope may
// confer a session's attachments; unscoped consumers get no extra authority.
export const Directories = Context.Reference<readonly string[]>("@opencode/SessionWorkspace.Directories", {
  defaultValue: (): readonly string[] => [],
})

export const context = Effect.gen(function* () {
  return { ...(yield* InstanceState.context), additionalDirectories: [...(yield* Directories)] }
})

export const provide = (sessionID: SessionID) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const folders = yield* SessionFolders.Service
    return yield* effect.pipe(Effect.provideService(Directories, yield* folders.list(sessionID)))
  })

export * as SessionWorkspace from "./workspace"
