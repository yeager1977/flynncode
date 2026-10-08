import { createEffect, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "./session-layout"
import { storeArtifact } from "@/pages/layout/sidebar-artifacts"
import { browserAnnotation } from "./hunk-revert"
import { browserPaneUrlFor, isLocalPreviewUrl, normalizePreviewUrl, setBrowserPaneUrl } from "./browser-pane"
import { previewDotClass, previewErrorDetail, previewManaged, type PreviewServerState } from "./preview-server"

export function ReviewBrowser(props: { onAnnotate: (comment: string) => void }) {
  const language = useLanguage()
  const sdk = useSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const layout = useSessionLayout()
  // The pane URL persists per session: switching sessions restores each
  // session's URL from the module record instead of resetting to default.
  const paneKey = () => layout.params.id ?? sdk().directory ?? "default"
  const [state, setState] = createStore({
    url: browserPaneUrlFor(paneKey(), "http://127.0.0.1:3000"),
    loaded: browserPaneUrlFor(paneKey(), "http://127.0.0.1:3000"),
    note: "",
    open: false,
    marking: false,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    marked: false,
    frame: 0,
    menu: false,
    busy: "",
    actionError: "",
    announced: "",
  })
  // Normalizes raw URL-bar input against the currently loaded URL and
  // remembers the result for this session.
  const commitUrl = (raw: string) => {
    const normalized = normalizePreviewUrl(raw, state.loaded)
    setBrowserPaneUrl(paneKey(), normalized)
    setState({ url: normalized, loaded: normalized })
  }
  createEffect(() => {
    const stored = browserPaneUrlFor(paneKey(), state.loaded)
    if (stored !== state.loaded) setState({ url: stored, loaded: stored })
  })
  // Lane A: preview servers come from the new /preview/servers endpoint.
  const [servers, serversActions] = createResource(
    () => true,
    async () => {
      try {
        const result = await sdk().client.preview.servers.list({ directory: sdk().directory })
        return (result.data ?? []) as PreviewServerState[]
      } catch {
        return []
      }
    },
  )
  const selected = () => servers()?.[0]
  const runServerAction = async (action: "start" | "stop" | "restart", server: PreviewServerState) => {
    setState("busy", server.name)
    try {
      const result = await sdk().client.preview.servers[action](
        { directory: sdk().directory, previewStartPayload: { name: server.name } },
        { throwOnError: true },
      )
      const info = result.data
      if (info?.url) commitUrl(info.url)
      await serversActions.refetch()
      if (info?.url) setState("open", true)
    } catch (error) {
      setState("actionError", previewErrorDetail(error) ?? language.t("preview.error.actionFailed"))
    } finally {
      setState("busy", "")
    }
  }
  const openAttachUrl = (server: PreviewServerState) => {
    if (!previewManaged(server) && server.url) {
      commitUrl(server.url)
      setState("open", true)
      return
    }
    if (server.url) platform.openExternal(server.url)
  }
  // "Edit config" opens the settings dialog on the preview tab, matching how
  // other panes deep-link into settings dialogs.
  const openEditConfig = async () => {
    setState("menu", false)
    const module = await import("@/components/settings-v2")
    void dialog.show(() => <module.DialogSettings defaultValue="preview" />)
  }
  // The sandboxed iframe keeps an opaque origin, so only loopback http(s)
  // targets can load; anything needing cookies/localStorage waits for a
  // future native host.
  const local = () => isLocalPreviewUrl(state.loaded)
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
  let frame: HTMLIFrameElement | undefined
  // Capture only the browser pane, never the whole window (chat, sidebar).
  const capture = async () => {
    const box = frame?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return undefined
    const result = await window.api?.capturePage?.({
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    })
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
    // An empty submit with an unchanged URL is an annotation attempt without
    // a note; a changed URL is a navigation submit and still loads.
    if (!text) {
      if (state.url === state.loaded) {
        setState("actionError", language.t("session.review.browserPane.emptyNote"))
        return
      }
      setState("actionError", "")
      commitUrl(state.url)
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
    setState({ note: "", marked: false, width: 0, height: 0, actionError: "" })
    setState("announced", language.t("session.review.browserPane.annotateSent"))
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
    setState("announced", language.t("session.review.browserPane.annotateSent"))
  }
  // One-click verify: point the pane back at the running preview server and
  // force the iframe to reload. The agent-side verify_page tool (preview
  // plugin) then reports HTTP status and DOM state to the model.
  const verify = () => {
    const running = servers()?.find((server) => server.url && previewManaged(server)) ?? selected()
    if (running?.url) commitUrl(running.url)
    setState("frame", state.frame + 1)
  }

  return (
    <div data-component="browser-pane" class="flex min-h-0 flex-col border-t border-border-weak-base">
      <div class="px-2 pt-2 text-12-regular text-text-weak">{language.t("session.review.browserPane.title")}</div>
      <div class="flex gap-2 p-2">
        <Show when={(servers() ?? []).length > 0}>
          <DropdownMenu gutter={4} placement="bottom-start" open={state.menu} onOpenChange={(open) => setState("menu", open)}>
            <DropdownMenu.Trigger
              as={Button}
              size="small"
              variant="ghost"
              aria-label={language.t("preview.servers.menu")}
            >
              <span aria-hidden="true" data-slot="preview-state-dot" class={`size-2 rounded-full ${previewDotClass(selected()?.state ?? "stopped")}`} />
              {selected()?.name ?? language.t("preview.servers.title")}
              <Icon name="chevron-down" size="small" class="text-icon-weak" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <DropdownMenu.Group>
                  <DropdownMenu.GroupLabel>{language.t("preview.servers.title")}</DropdownMenu.GroupLabel>
                  <For each={servers() ?? []}>
                    {(server) => (
                      <DropdownMenu.Item
                        disabled={state.busy === server.name}
                        onSelect={() => {
                          setState("menu", false)
                          if (previewManaged(server)) {
                            if (server.state === "running" || server.state === "starting") {
                              void runServerAction("stop", server)
                              return
                            }
                            void runServerAction("start", server)
                            return
                          }
                          openAttachUrl(server)
                        }}
                      >
                        <span aria-hidden="true" class={`size-2 rounded-full ${previewDotClass(server.state)}`} />
                        <DropdownMenu.ItemLabel>
                          {previewManaged(server)
                            ? server.state === "running" || server.state === "starting"
                              ? language.t("preview.action.stop")
                              : language.t("preview.action.start")
                            : language.t("preview.action.openUrl")}
                        </DropdownMenu.ItemLabel>
                        <DropdownMenu.ItemLabel class="text-text-weak">{server.name}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    )}
                  </For>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    disabled={!selected() || state.busy !== "" || !previewManaged(selected()!)}
                    onSelect={() => {
                      const server = selected()
                      if (!server) return
                      setState("menu", false)
                      void runServerAction("restart", server)
                    }}
                  >
                    {language.t("preview.action.restart")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      setState("menu", false)
                      void openEditConfig()
                    }}
                  >
                    {language.t("preview.action.editConfig")}
                  </DropdownMenu.Item>
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </Show>
        <Button
          type="button"
          size="small"
          variant={state.open ? "primary" : "ghost"}
          aria-label={
            state.open ? language.t("session.review.browserPane.close") : language.t("session.review.browserPane.open")
          }
          onClick={() => setState("open", !state.open)}
        >
          {state.open ? language.t("session.review.browserPane.close") : language.t("session.review.browserPane.open")}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={!state.open}
          aria-label={language.t("session.review.browserPane.reload")}
          onClick={() => setState("frame", state.frame + 1)}
        >
          {language.t("session.review.browserPane.reload")}
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
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={!state.open || !selected()?.url}
          aria-label={language.t("session.review.browserPane.verify")}
          onClick={() => verify()}
        >
          {language.t("session.review.browserPane.verify")}
        </Button>
        <Button type="button" size="small" variant="ghost" disabled={!state.open} onClick={() => commitUrl(state.url)}>
          {language.t("common.goForward")}
        </Button>
      </div>
      <Show when={state.actionError}>
        <div class="px-2 pb-2 text-12-regular text-text-critical">{state.actionError}</div>
      </Show>
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
            placeholder={language.t("session.review.browserPane.urlPlaceholder")}
          />
          <input
            class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-12-regular"
            value={state.note}
            onInput={(event) => setState({ note: event.currentTarget.value, announced: "" })}
            aria-label={language.t("session.review.browserNote")}
          />
          <Button
            type="button"
            size="small"
            variant={state.marking ? "primary" : "ghost"}
            aria-pressed={state.marking}
            aria-label={language.t("session.review.markPreview")}
            onClick={() => setState("marking", !state.marking)}
          >
            {language.t("session.review.markPreview")}
          </Button>
          <Button type="submit" size="small" disabled={state.note.trim().length === 0}>
            {language.t("session.review.annotate.add")}
          </Button>
        </form>
        <div aria-live="polite" class="sr-only">
          {state.announced}
        </div>
        <Show when={local()} fallback={<div class="p-3 text-12-regular text-text-weak">{language.t("session.review.browserLocalOnly")}</div>}>
          <div class="relative h-64 min-h-0">
            <iframe
              ref={(element) => {
                frame = element
              }}
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
