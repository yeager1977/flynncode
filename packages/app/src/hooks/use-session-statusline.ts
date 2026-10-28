import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { ansiPlainText } from "@flynncode/ui/theme/ansi"
import { useSDK } from "@/context/sdk"

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
  const [lines, setLines] = createSignal<string[]>([])
  const source = createStatusLineSource(setLines)

  // Opening a session is also what starts the server watching it and re-arms a stale result.
  createEffect(
    on(sessionID, (id) => {
      source.reset()
      if (!id) return
      void source.fetch(async () => {
        const result = await sdk().client.session.statusline.get({ sessionID: id })
        return result.data?.lines
      })
    }),
  )

  createEffect(() => {
    const off = sdk().event.on("session.statusline", (event) => {
      if (event.properties.sessionID === sessionID()) source.push(event.properties.lines)
    })
    onCleanup(off)
  })

  return lines
}
