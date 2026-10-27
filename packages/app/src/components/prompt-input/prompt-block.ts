import { hookBlockReason } from "@/utils/server-errors"

type WatchedEvent = { type: string; properties?: unknown }

// Longer than a command hook's default 600 s timeout.
const PROMPT_BLOCK_WATCH_MS = 11 * 60 * 1000

// prompt_async answers before the UserPromptSubmit hooks run, so a hook's
// block reaches the app later, as a session.error for the session, and nothing
// else undoes the optimistic send. This watches one sent message until the
// server admits it (its message.updated) or a hook blocks it, and then calls
// `blocked` with the hook's reason. Other session errors belong to the running
// turn, not to this message, and are ignored. Returns the stop function; the
// watch also stops on its own after `timeoutMs`.
export function watchPromptBlock(input: {
  sessionID: string
  messageID: string
  listen: (handler: (event: WatchedEvent) => void) => () => void
  blocked: (reason: string) => void
  timeoutMs?: number
}) {
  const watch = { done: false, off: () => {}, timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const stop = () => {
    if (watch.done) return
    watch.done = true
    clearTimeout(watch.timer)
    watch.off()
  }
  watch.off = input.listen((event) => {
    if (watch.done) return
    const props = asRecord(event.properties)
    if (event.type === "message.updated") {
      const info = asRecord(props.info)
      if (info.sessionID === input.sessionID && info.id === input.messageID) stop()
      return
    }
    if (event.type !== "session.error" || props.sessionID !== input.sessionID) return
    const reason = hookBlockReason(props.error)
    if (reason === undefined) return
    stop()
    input.blocked(reason)
  })
  watch.timer = setTimeout(stop, input.timeoutMs ?? PROMPT_BLOCK_WATCH_MS)
  return stop
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}
