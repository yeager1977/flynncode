import type { SidecarSyncCommand } from "./sidecar-sync"

// The sidecar is the whole server. It has died of V8 heap exhaustion (exit 133) after a few hours of
// uptime, and nothing started it again, so the window sat on a dead local server until the app was
// relaunched. The supervisor starts a replacement on the same port and password, so the renderer's
// event stream reconnects by itself.
const RESTART_WINDOW_MS = 10 * 60_000
const MAX_RESTARTS_IN_WINDOW = 5
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 15_000

export type SupervisedSidecar = {
  listener: { stop: () => Promise<void> }
  health: { wait: Promise<void> }
  post: (command: SidecarSyncCommand) => boolean
}

type GiveUpReason = "clean-exit" | "crash-loop"

type SuperviseOptions = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onRestart?: (info: { code: number; attempt: number; delayMs: number }) => void
  onRestartFailed?: (error: unknown) => void
  onGiveUp?: (info: { code: number; reason: GiveUpReason }) => void
}

export function restartDecision(input: { code: number; stopping: boolean; restarts: number[]; now: number }) {
  if (input.stopping) return { restart: false, reason: "stopped" } as const
  // The sidecar exits 0 only after a stop request, so an unrequested clean exit is deliberate.
  if (input.code === 0) return { restart: false, reason: "clean-exit" } as const
  const recent = input.restarts.filter((at) => input.now - at < RESTART_WINDOW_MS).length
  // A sidecar that cannot stay up (corrupt database, port taken) would otherwise restart forever.
  if (recent >= MAX_RESTARTS_IN_WINDOW) return { restart: false, reason: "crash-loop" } as const
  return { restart: true, delayMs: Math.min(BASE_DELAY_MS * 2 ** recent, MAX_DELAY_MS) } as const
}

/**
 * Runs `start` and starts it again when the sidecar it returned exits abnormally after becoming ready.
 * `start` receives the callback to report that sidecar's exit and must build its options fresh each call.
 * A failure of the first start is not retried: it surfaces to the caller as before.
 */
export async function superviseSidecar(
  start: (onExit: (code: number) => void) => Promise<SupervisedSidecar>,
  options: SuperviseOptions = {},
): Promise<SupervisedSidecar> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const restarts: number[] = []
  let stopping = false
  let current: SupervisedSidecar | undefined

  // A start that fails reports its own exit and then rejects; only the rejection is acted on.
  const launch = async () => {
    let live = false
    const next = await start((code) => {
      if (live) void onExit(code)
    })
    live = true
    return next
  }

  const onExit = async (code: number): Promise<void> => {
    current = undefined
    const decision = restartDecision({ code, stopping, restarts, now: now() })
    if (!decision.restart) {
      if (decision.reason !== "stopped") options.onGiveUp?.({ code, reason: decision.reason })
      return
    }
    restarts.push(now())
    options.onRestart?.({
      code,
      attempt: restarts.filter((at) => now() - at < RESTART_WINDOW_MS).length,
      delayMs: decision.delayMs,
    })
    await sleep(decision.delayMs)
    if (stopping) return
    const next = await launch().catch((error) => {
      options.onRestartFailed?.(error)
    })
    // A replacement that cannot start counts as another crash, so the limit above applies to it.
    if (!next) return onExit(1)
    if (stopping) return next.listener.stop()
    current = next
  }

  const first = await launch()
  current = first

  return {
    listener: {
      stop: () => {
        stopping = true
        return current?.listener.stop() ?? Promise.resolve()
      },
    },
    health: first.health,
    post: (command) => current?.post(command) ?? false,
  }
}
