const TRACE_STORAGE_KEY = "opencode.startupTrace"

export type Trace = {
  readonly enabled: boolean
  readonly mark: (name: string, detail?: Record<string, unknown>) => void
}

export type TraceInput = {
  readonly enabled: boolean
  readonly now?: () => number
  readonly log?: (message: string, detail?: Record<string, unknown>) => void
}

/**
 * Startup timing is opt-in outside development because it is diagnostic noise in
 * a normal session. Enable it in a packaged app by setting the localStorage key
 * to "1" from the devtools console, then reproduce the slow launch.
 */
export function startupTraceEnabled() {
  try {
    if (typeof localStorage === "object" && localStorage.getItem(TRACE_STORAGE_KEY) === "1") return true
  } catch {
    // Storage can be unavailable in restricted contexts; fall through to the default.
  }
  return import.meta.env.DEV === true
}

/**
 * Records how long startup spends in each gate so a blank launch can be traced
 * to the stage that is actually waiting. Each mark logs both the time since
 * startup began and the delta since that mark last fired.
 */
export function createStartupTrace(input: TraceInput): Trace {
  const now = input.now ?? Date.now
  // A single string keeps the mark intact when a host only forwards the first
  // console argument, such as Electron's console-message event.
  const log = input.log ?? ((message, detail) => console.info(`${message} ${JSON.stringify(detail)}`))
  const start = now()
  let last = start

  return {
    enabled: input.enabled,
    mark(name, detail) {
      if (!input.enabled) return
      const at = now()
      // `since` is the gap from the previous mark, so the slow stage is the one
      // with the largest gap rather than the one furthest from process start.
      const since = at - last
      last = at
      log(`[startup] ${name}`, { at: at - start, since, ...detail })
    },
  }
}

export const startupTrace: Trace = createStartupTrace({ enabled: startupTraceEnabled() })

export * as StartupTrace from "./startup-trace"
