import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Session, SessionRetention } from "@flynncode/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

// One snapshot for the whole sidebar. `GET /session/retention` runs a full tree
// query, so it is fetched once and then only when the server says it changed
// (a pass, a Keep change or a new period) or the event stream reconnects.
export function useSessionRetention() {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [retention, setRetention] = createSignal<SessionRetention>()
  // A Keep write shows at once; the next snapshot replaces it.
  const [overrides, setOverrides] = createStore<Record<string, boolean>>({})
  // A newer request invalidates in-flight ones, so a slow response cannot overwrite a fresher snapshot.
  let generation = 0

  const refresh = async () => {
    const run = ++generation
    const result = await serverSDK()
      .client.session.retention.get()
      .catch(() => undefined)
    if (!result || run !== generation) return
    setRetention(result.data)
    setOverrides(reconcile({}))
  }

  createEffect(
    on(serverSDK, () => {
      generation++
      setRetention(undefined)
      setOverrides(reconcile({}))
      void refresh()
    }),
  )

  createEffect(() => {
    const off = serverSDK().event.on("global", (event) => {
      if (event.type === "session.retention.updated") void refresh()
      // Like the rest of the app's state: refetched after the stream reconnects to a (possibly restarted) server.
      if (event.type === "server.connected" || event.type === "global.disposed") void refresh()
    })
    onCleanup(off)
  })

  // The loaded session list carries no metadata, so Keep state comes from the snapshot's `kept` list.
  const kept = (session: Session) => overrides[session.id] ?? retention()?.kept.includes(session.id) ?? false

  const keep = async (session: Session, next: boolean) => {
    const ok = await serverSDK()
      .client.session.keep({ sessionID: session.id, directory: session.directory, keep: next })
      .then(() => true)
      .catch(() => false)
    if (!ok) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    setOverrides(session.id, next)
  }

  return { retention, kept, keep }
}
