import { createEffect, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSessionLayout } from "./session-layout"
import { storeArtifact } from "@/pages/layout/sidebar-artifacts"
import { browserAnnotation, type BrowserAnnotationPayload } from "./hunk-revert"
import { browserPaneUrlFor, isLocalPreviewUrl, normalizePreviewUrl, setBrowserPaneUrl } from "./browser-pane"
import { previewDotClass, previewErrorDetail, previewManaged, type PreviewServerState } from "./preview-server"

export function ReviewBrowser(props: {
  file?: string
  onAnnotate: (input: BrowserAnnotationPayload) => void
  onClose: () => void
}) {
  const language = useLanguage()
  const sdk = useSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const layout = useSessionLayout()
  const sync = useServerSync()
  // The pane URL persists per session: switching sessions restores each
  // session's URL from the module record instead of resetting to default.
  const paneKey = () => layout.params.id ?? sdk().directory ?? "default"
  const [state, setState] = createStore({
    url: browserPaneUrlFor(paneKey(), "http://127.0.0.1:3000"),
    loaded: browserPaneUrlFor(paneKey(), "http://127.0.0.1:3000"),
    note: "",
    marking: false,
    // Point mode places a zero-size percent rect on a single pointerdown and
    // completes the mark there; drag mode keeps the old press-move behavior.
    point: false,
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
    native: false,
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
    } catch (error) {
      setState("actionError", previewErrorDetail(error) ?? language.t("preview.error.actionFailed"))
    } finally {
      setState("busy", "")
    }
  }
  const openAttachUrl = (server: PreviewServerState) => {
    if (!previewManaged(server) && server.url) {
      commitUrl(server.url)
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
  // The sandboxed iframe keeps an opaque origin, so cookies/localStorage do
  // not persist across reloads; the native host (flag on, desktop only)
  // hosts the same page in a real view instead.
  const local = () => isLocalPreviewUrl(state.loaded)
  // Native preview host (desktop only): the pane prefers the native view when
  // the config flag is on and the desktop API exists. Any host failure tears
  // the view down and returns the pane to the sandboxed iframe.
  const nativeApi = () => window.api?.previewHost
  const nativeWanted = () => nativeApi() !== undefined && sync().data.config.preview?.nativeHost === true && local()
  createEffect(() => {
    const host = nativeApi()
    if (!host) return
    if (nativeWanted()) {
      // Reading state.frame tracks reload bumps so the reload button reloads
      // the native view too; attach always performs a fresh loadURL.
      state.frame
      void host.attach(state.loaded).then(
        () => setState("native", true),
        () => {
          setState("native", false)
          void host.detach().catch(() => {})
        },
      )
      return
    }
    if (!state.native) return
    setState("native", false)
    void host.detach().catch(() => {})
  })
  // The native view composites above the renderer window, so it must be told
  // where the pane sits (CSS px → DIP conversion happens main-side) and must
  // shrink to nothing while the mark overlay needs pointer events.
  const syncNativeBounds = () => {
    const host = nativeApi()
    if (!host || !state.native) return
    if (state.marking) {
      void host.setBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => {})
      return
    }
    const box = paneBox?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return
    void host.setBounds({ x: box.x, y: box.y, width: box.width, height: box.height }).catch(() => {})
  }
  createEffect(() => {
    if (!state.native) return
    syncNativeBounds()
    const observer = new ResizeObserver(syncNativeBounds)
    if (paneBox) observer.observe(paneBox)
    document.addEventListener("scroll", syncNativeBounds, true)
    window.addEventListener("resize", syncNativeBounds)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("scroll", syncNativeBounds, true)
      window.removeEventListener("resize", syncNativeBounds)
    })
  })
  onCleanup(() => {
    const host = nativeApi()
    if (!host) return
    void host.detach().catch(() => {})
  })
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
  let paneBox: HTMLDivElement | undefined
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
    const dataUrl = state.marked ? await capture() : undefined
    const comment = state.marked
      ? browserAnnotation({
          url: state.loaded,
          path: pagePath(state.loaded),
          note: text,
          x: state.x,
          y: state.y,
          width: state.width,
          height: state.height,
        })
      : `${state.loaded}: ${text}`
    props.onAnnotate({
      file: props.file ?? "preview",
      comment,
      rect: { x: state.x, y: state.y, width: state.width, height: state.height },
      screenshot: dataUrl,
    })
    storeAnnotation({ url: state.loaded, note: text, thumbnail: dataUrl })
    setState({ note: "", marked: false, width: 0, height: 0, actionError: "" })
    setState("announced", language.t("session.review.browserPane.annotateSent"))
  }
  const recheck = async () => {
    const text = state.note.trim()
    if (!text || !state.marked) return
    const dataUrl = await capture()
    props.onAnnotate({
      file: props.file ?? "preview",
      comment: browserAnnotation({
        url: state.loaded,
        path: pagePath(state.loaded),
        note: text,
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
      }),
      rect: { x: state.x, y: state.y, width: state.width, height: state.height },
      screenshot: dataUrl,
    })
    storeAnnotation({ url: state.loaded, note: text, thumbnail: dataUrl })
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
    <div data-component="browser-pane" class="flex h-full min-h-0 flex-col border-t border-border-weak-base">
      <div class="flex items-center justify-between gap-2 px-2 pt-2">
        <span class="text-12-regular text-text-weak">{language.t("session.review.browserPane.title")}</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          size="small"
          data-action="review-browser-close"
          aria-label={language.t("session.review.browserPane.close")}
          onClick={props.onClose}
        />
      </div>
      <div class="flex gap-2 p-2">
        <Show when={(servers() ?? []).length > 0}>
          <DropdownMenu
            gutter={4}
            placement="bottom-start"
            open={state.menu}
            onOpenChange={(open) => setState("menu", open)}
          >
            <DropdownMenu.Trigger
              as={Button}
              size="small"
              variant="ghost"
              aria-label={language.t("preview.servers.menu")}
            >
              <span
                aria-hidden="true"
                data-slot="preview-state-dot"
                class={`size-2 rounded-full ${previewDotClass(selected()?.state ?? "stopped")}`}
              />
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
          variant="ghost"
          aria-label={language.t("session.review.browserPane.reload")}
          onClick={() => setState("frame", state.frame + 1)}
        >
          {language.t("session.review.browserPane.reload")}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={!state.marked || state.note.trim().length === 0}
          onClick={() => void recheck()}
        >
          {language.t("session.review.recheckPage")}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={!selected()?.url}
          aria-label={language.t("session.review.browserPane.verify")}
          onClick={() => verify()}
        >
          {language.t("session.review.browserPane.verify")}
        </Button>
        <Button type="button" size="small" variant="ghost" onClick={() => commitUrl(state.url)}>
          {language.t("common.goForward")}
        </Button>
      </div>
      <Show when={state.actionError}>
        <div class="px-2 pb-2 text-12-regular text-text-critical">{state.actionError}</div>
      </Show>
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
          variant={state.marking && !state.point ? "primary" : "ghost"}
          aria-pressed={state.marking && !state.point}
          aria-label={language.t("session.review.markPreview")}
          onClick={() => setState({ marking: !state.marking, point: false })}
        >
          {language.t("session.review.markPreview")}
        </Button>
        <Button
          type="button"
          size="small"
          variant={state.marking && state.point ? "primary" : "ghost"}
          aria-pressed={state.marking && state.point}
          data-action="mark-point"
          aria-label={language.t("session.review.markPoint")}
          onClick={() => {
            if (state.marking && state.point) {
              setState("marking", false)
              return
            }
            setState({ marking: true, point: true })
          }}
        >
          {language.t("session.review.markPoint")}
        </Button>
        <Button type="submit" size="small" disabled={state.note.trim().length === 0}>
          {language.t("session.review.annotate.add")}
        </Button>
      </form>
      <div aria-live="polite" class="sr-only">
        {state.announced}
      </div>
      <Show
        when={local()}
        fallback={<div class="p-3 text-12-regular text-text-weak">{language.t("session.review.browserLocalOnly")}</div>}
      >
        <div
          ref={(element) => {
            paneBox = element
          }}
          class="relative min-h-0 flex-1"
        >
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
                if (state.point) {
                  mark(event, event.currentTarget, false)
                  return
                }
                event.currentTarget.setPointerCapture(event.pointerId)
                mark(event, event.currentTarget, false)
              }}
              onPointerMove={(event) => {
                if (state.point) return
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
    </div>
  )
}
