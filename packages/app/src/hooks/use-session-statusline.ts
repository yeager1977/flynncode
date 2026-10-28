import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { ansiPlainText } from "@flynncode/ui/theme/ansi"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

export function statusLineVisible(lines: readonly string[]) {
  return lines.some((line) => ansiPlainText(line).trim() !== "")
}

// An event is newer than any fetch that started before it, and a reset (session switch)
// invalidates every fetch in flight, so a slow response can never overwrite fresher lines.
export function createStatusLineSource(apply: (lines: string[]) => void) {
  let generation = 0
  return {
    push(lines: string[]) {
      generation++
      apply(lines)
    },
    reset() {
      generation++
      apply([])
    },
    async fetch(load: () => Promise<string[] | undefined>) {
      const run = generation
      const lines = await load().catch(() => undefined)
      if (!lines || run !== generation) return
      apply(lines)
    },
  }
}

export function useSessionStatusLine(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [lines, setLines] = createSignal<string[]>([])
  const source = createStatusLineSource(setLines)

  // A GET is what starts the server watching a session and renews the watch, which lapses after five idle minutes
  // without one. The server keeps watches in memory only, so a restarted server knows nothing until asked again.
  const fetch = () => {
    const id = sessionID()
    if (!id) return
    void source.fetch(async () => {
      const result = await sdk().client.session.statusline.get({ sessionID: id })
      return result.data?.lines
    })
  }

  createEffect(
    on(sessionID, () => {
      source.reset()
      fetch()
    }),
  )

  createEffect(() => {
    const off = sdk().event.on("session.statusline", (event) => {
      if (event.properties.sessionID === sessionID()) source.push(event.properties.lines)
    })
    onCleanup(off)
  })

  // A turn starting or ending renews the watch, so a session left open and idle keeps updating when it works again.
  createEffect(() => {
    const off = sdk().event.on("session.status", (event) => {
      if (event.properties.sessionID === sessionID()) fetch()
    })
    onCleanup(off)
  })

  // Like the rest of the app's state: refetched after the event stream reconnects to a (possibly restarted) server.
  createEffect(() => {
    const off = serverSDK().event.on("global", (event) => {
      if (event.type === "server.connected" || event.type === "global.disposed") fetch()
    })
    onCleanup(off)
  })

  return lines
}
