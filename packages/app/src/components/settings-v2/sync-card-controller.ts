import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  MachineSyncPairingCode,
  MachineSyncPlatform,
  MachineSyncPrefsChoice,
  MachineSyncStatus,
} from "@/context/machine-sync-types"
import { syncNowFailed, syncPairNotice } from "./sync-card-status"

type Busy = "code" | "syncNow" | "pause" | "unpair"

// All state and side effects of the Sync card live here so the component is
// only markup; `now` is injectable for tests. `fail` is told about user
// initiated actions that did not work, so the view can toast them.
export function createSyncCardController(input: {
  api: MachineSyncPlatform | undefined
  fail: (key: "server.sync.toast.failed" | "server.sync.toast.actionFailed") => void
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const [state, setState] = createStore({
    status: undefined as MachineSyncStatus | undefined,
    code: undefined as (MachineSyncPairingCode & { minutes: number }) | undefined,
    host: "",
    pairCode: "",
    prefs: "keep" as MachineSyncPrefsChoice,
    pairFailure: undefined as "unreachable" | "invalid-code" | "failed" | undefined,
    pairNotice: undefined as ReturnType<typeof syncPairNotice>,
    pairing: false,
    busy: undefined as Busy | undefined,
  })
  const [clock, setClock] = createSignal(now())

  const api = input.api
  if (api) {
    void api
      .status()
      .then((status) => setState("status", status))
      .catch(() => undefined)
    onCleanup(api.subscribe((status) => setState("status", status)))
  }

  // The code stops being shown once it expires; the timer is cleared with the
  // owner, so nothing fires after unmount.
  createEffect(
    on(
      () => state.code?.expiresAt,
      (expiresAt) => {
        if (expiresAt === undefined) return
        setClock(now())
        const timer = setTimeout(() => setClock(now()), Math.max(0, expiresAt - now()))
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )

  // Once paired, a code is spent: drop it so it never reappears after an unpair.
  createEffect(
    on(
      () => state.status?.paired === true,
      (paired) => {
        if (paired) setState("code", undefined)
      },
    ),
  )

  const code = createMemo(() => {
    const current = state.code
    if (!current || state.status?.paired === true) return undefined
    return clock() < current.expiresAt ? current : undefined
  })

  // Runs one user-initiated action at a time per button.
  const guarded = (key: Busy, run: () => Promise<unknown> | undefined) => {
    if (state.busy === key) return
    setState("busy", key)
    void (run() ?? Promise.resolve()).finally(() => setState("busy", (busy) => (busy === key ? undefined : busy)))
  }
  const failed = (error: unknown, key: "server.sync.toast.failed" | "server.sync.toast.actionFailed") => {
    console.warn("[machine-sync]", error)
    input.fail(key)
  }

  return {
    state,
    /** For the form fields: host, pairCode and prefs. */
    set: setState,
    code,
    showCode() {
      guarded("code", () =>
        api?.createPairingCode().then(
          (created) =>
            setState("code", {
              ...created,
              minutes: Math.max(1, Math.round((created.expiresAt - now()) / 60_000)),
            }),
          (error) => failed(error, "server.sync.toast.actionFailed"),
        ),
      )
    },
    pair() {
      const host = state.host.trim()
      const pairCode = state.pairCode.trim()
      if (!api || state.pairing || !host || !pairCode) return
      setState({ pairing: true, pairFailure: undefined, pairNotice: undefined })
      void api
        .pair({ host, code: pairCode, prefs: state.prefs })
        .then((result) => {
          if (result.ok) {
            setState({ pairing: false, host: "", pairCode: "", code: undefined, pairNotice: syncPairNotice(result) })
            return
          }
          setState({ pairing: false, pairFailure: result.reason })
        })
        .catch(() => setState({ pairing: false, pairFailure: "failed" }))
    },
    syncNow() {
      guarded("syncNow", () =>
        api?.syncNow().then(
          (status) => {
            setState("status", status)
            if (syncNowFailed(status)) input.fail("server.sync.toast.failed")
          },
          (error) => failed(error, "server.sync.toast.failed"),
        ),
      )
    },
    togglePause() {
      guarded("pause", () =>
        api?.setPaused(state.status?.paused !== true).catch((error) => failed(error, "server.sync.toast.actionFailed")),
      )
    },
    unpair() {
      setState({ pairNotice: undefined, code: undefined })
      guarded("unpair", () => api?.unpair().catch((error) => failed(error, "server.sync.toast.actionFailed")))
    },
  }
}
