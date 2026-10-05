import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "./session-layout"
import { storeArtifact } from "@/pages/layout/sidebar-artifacts"
import { browserAnnotation } from "./hunk-revert"

export function ReviewBrowser(props: { onAnnotate: (comment: string) => void }) {
  const language = useLanguage()
  const sdk = useSDK()
  const layout = useSessionLayout()
  const [state, setState] = createStore({
    url: "http://127.0.0.1:3000",
    loaded: "http://127.0.0.1:3000",
    note: "",
    open: false,
    marking: false,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    marked: false,
    frame: 0,
  })
  const local = () => {
    try {
      const parsed = new URL(state.loaded)
      return parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
      return false
    }
  }
  const mark = (event: PointerEvent, el: HTMLElement, drag: boolean) => {
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return
    const x = ((event.clientX - box.left) / box.width) * 100
    const y = ((event.clientY - box.top) / box.height) * 100
    if (!drag) {
      setState({ x, y, width: 0, height: 0, marked: true })
      return
    }
    setState({ width: x - state.x, height: y - state.y, marked: true })
  }
  const stripHash = (url: string) => {
    const hash = url.indexOf("#")
    return hash === -1 ? url : url.slice(0, hash)
  }
  const hashOf = (url: string) => {
    const hash = url.indexOf("#")
    return hash === -1 ? "" : url.slice(hash)
  }
  const pagePath = (url: string) => {
    try {
      return new URL(url).pathname
    } catch {
      return undefined
    }
  }
  const capture = async () => {
    const result = await window.api?.capturePage?.()
    if (typeof result !== "string" || !result.startsWith("data:")) return undefined
    return result
  }
  // Lane 2 → Lane 4 wiring: an annotation also lands in the sidebar artifact
  // store as a screenshot so the picture survives the session transcript.
  const storeAnnotation = (input: { url: string; note: string; thumbnail?: string }) => {
    const sessionID = layout.params.id
    if (!sessionID) return
    const directory = sdk().directory
    if (!directory) return
    storeArtifact(directory, {
      type: "screenshot",
      sessionID,
      url: input.url,
      note: input.note,
      path: pagePath(input.url),
      rect: { x: state.x, y: state.y, width: state.width, height: state.height },
      thumbnail: input.thumbnail,
    })
  }
  const annotate = async () => {
    const text = state.note.trim()
    if (!text) {
      setState("loaded", state.url)
      return
    }
    const thumbnail = state.marked ? await capture() : undefined
    const comment = state.marked
      ? browserAnnotation({
          url: state.loaded,
          path: pagePath(state.loaded),
          note: text,
          x: state.x,
          y: state.y,
          width: state.width,
          height: state.height,
          thumbnail,
        })
      : `${state.loaded}: ${text}`
    props.onAnnotate(comment)
    storeAnnotation({ url: state.loaded, note: text, thumbnail: state.marked ? thumbnail : undefined })
    setState({ note: "", marked: false, width: 0, height: 0 })
  }
  const recheck = async () => {
    const text = state.note.trim()
    if (!text || !state.marked) return
    const thumbnail = await capture()
    props.onAnnotate(
      browserAnnotation({
        url: state.loaded,
        path: pagePath(state.loaded),
        note: text,
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
        thumbnail,
      }),
    )
    storeAnnotation({ url: state.loaded, note: text, thumbnail })
  }

  return (
    <div data-component="review-browser" class="flex min-h-0 flex-col border-t border-border-weak-base">
      <div class="flex gap-2 p-2">
        <Button type="button" size="small" variant={state.open ? "primary" : "ghost"} onClick={() => setState("open", !state.open)}>
          {language.t("common.open")}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={!state.open}
          onClick={() => setState("frame", state.frame + 1)}
        >
          {language.t("common.reset")}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={!state.open || !state.marked || state.note.trim().length === 0}
          onClick={() => void recheck()}
        >
          {language.t("session.review.recheckPage")}
        </Button>
        <Button type="button" size="small" variant="ghost" disabled={!state.open} onClick={() => setState("loaded", state.url)}>
          {language.t("common.goForward")}
        </Button>
      </div>
      <Show when={state.open}>
        <form
          class="flex gap-2 px-2 pb-2"
          onSubmit={(event) => {
            event.preventDefault()
            void annotate()
          }}
        >
          <input
            class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-12-regular"
            value={state.url}
            onInput={(event) => setState("url", event.currentTarget.value)}
            aria-label={language.t("session.review.browserUrl")}
          />
          <input
            class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-12-regular"
            value={state.note}
            onInput={(event) => setState("note", event.currentTarget.value)}
            aria-label={language.t("session.review.browserNote")}
          />
          <Button
            type="button"
            size="small"
            variant={state.marking ? "primary" : "ghost"}
            onClick={() => setState("marking", !state.marking)}
          >
            {language.t("session.review.markPreview")}
          </Button>
          <Button type="submit" size="small" disabled={state.note.trim().length === 0}>
            {language.t("session.review.annotate.add")}
          </Button>
        </form>
        <Show when={local()} fallback={<div class="p-3 text-12-regular text-text-weak">{language.t("session.review.browserLocalOnly")}</div>}>
          <div class="relative h-64 min-h-0">
            <iframe
              class="size-full"
              // A hash on the loaded URL would swallow a query cache-buster;
              // put the reset counter in the hash position instead.
              src={`${stripHash(state.loaded)}${stripHash(state.loaded).includes("?") ? "&" : "?"}reload=${state.frame}${hashOf(state.loaded)}`}
              title={language.t("session.review.browserUrl")}
              sandbox="allow-scripts allow-forms"
            />
            <Show when={state.marking}>
              <div
                class="absolute inset-0 cursor-crosshair touch-none"
                data-action="review-browser-mark"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  mark(event, event.currentTarget, false)
                }}
                onPointerMove={(event) => {
                  if (event.buttons !== 1) return
                  mark(event, event.currentTarget, true)
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId)
                }}
              >
                <Show when={state.marked}>
                  <div
                    class="absolute border border-border-strong-base bg-surface-warning-base/30"
                    style={{
                      left: `${Math.min(state.x, state.x + state.width)}%`,
                      top: `${Math.min(state.y, state.y + state.height)}%`,
                      width: `${Math.abs(state.width)}%`,
                      height: `${Math.abs(state.height)}%`,
                    }}
                  />
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}
