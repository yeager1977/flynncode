import { makeEventListener } from "@solid-primitives/event-listener"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Icon as IconV2 } from "@flynncode/ui/v2/icon"
import { IconButtonV2 } from "@flynncode/ui/v2/icon-button-v2"
import { TextInputV2 } from "@flynncode/ui/v2/text-input-v2"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import type { ImageAttachmentPart, PromptSession } from "@/context/prompt"
import { useTabs, type Tab } from "@/context/tabs"
import { createBlobReference } from "@/utils/draft-store"
import { showToast } from "@/utils/toast"
import { uuid } from "@/utils/uuid"

export const quickEntryEvent = "opencode:quick-entry"

// Overlay opened by the desktop global quick-entry shortcut. Submitting opens
// a new draft in the most recent project with the typed prompt. Escape (from
// anywhere in the window), the close button, or clicking the backdrop closes
// it, so it can always be dismissed even when no project is open.
export function QuickEntryOverlay() {
  const language = useLanguage()
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const tabs = useTabs()
  const [state, setState] = createStore({ open: false, text: "", screenshot: null as { dataUrl: string } | null })
  const directory = () => layout.projects.list()[0]?.worktree
  const close = () => setState({ open: false, text: "", screenshot: null })

  makeEventListener(window, quickEntryEvent, () => setState("open", true))
  makeEventListener(window, "keydown", (event) => {
    if (!state.open || event.key !== "Escape") return
    event.preventDefault()
    close()
  })

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const target = directory()
    const prompt = state.text.trim()
    if (!target || !prompt) return
    // Read before close(): the store resets immediately, the attach runs after
    // the new draft's prompt session exists.
    const captured = state.screenshot
    void tabs.newDraft({ server: server.key, directory: target }, prompt).then(async (tab) => {
      if (!captured) return
      await attachScreenshotToDraft(tab, captured.dataUrl)
    })
    close()
  }

  const attachScreenshot = async () => {
    const captured = await platform.screenshot?.()
    if (!captured) {
      showToast({ title: language.t("quickEntry.attachFailed") })
      return
    }
    setState("screenshot", captured)
  }

  // Insert the capture as an image part into the new draft's prompt, the same
  // shape the clipboard-image and review-screenshot flows produce.
  const attachScreenshotToDraft = async (tab: Tab, dataUrl: string) => {
    const session = tabs.stateValue<PromptSession>(tab, "prompt")
    if (!session) {
      showToast({ title: language.t("quickEntry.attachFailed") })
      return
    }
    await fetch(dataUrl)
      .then((response) => response.blob())
      .then(async (blob) => {
        const filename = "screenshot.png"
        const attachment: ImageAttachmentPart = {
          type: "image",
          id: uuid(),
          filename,
          mime: dataUrlMime(dataUrl),
          blob: platform.draftStore
            ? await platform.draftStore.putBlob(blob)
            : await createBlobReference(new File([blob], filename, { type: dataUrlMime(dataUrl) })),
        }
        session.set([...session.current(), attachment], session.cursor())
      })
      .catch(() => showToast({ title: language.t("quickEntry.attachFailed") }))
  }

  return (
    <Show when={state.open}>
      <div
        data-component="quick-entry-backdrop"
        class="fixed inset-0 z-50 flex justify-center bg-v2-overlay-simple-overlay-scrim px-4 pt-12"
        onClick={(event) => {
          if (event.target === event.currentTarget) close()
        }}
      >
        <form
          data-component="quick-entry"
          class="flex h-fit w-[min(32rem,100%)] items-center gap-2 rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-base p-2"
          onSubmit={submit}
        >
          <Show
            when={directory()}
            fallback={
              <p class="min-w-0 flex-1 px-2 text-[13px] leading-5 text-v2-text-text-muted">
                {language.t("quickEntry.empty")}
              </p>
            }
          >
            <Show when={state.screenshot}>
              <img
                src={state.screenshot?.dataUrl}
                alt=""
                class="h-9 w-12 shrink-0 rounded-[6px] border border-v2-border-border-base object-cover"
              />
            </Show>
            <TextInputV2
              class="min-w-0 flex-1"
              appearance="large"
              value={state.text}
              ref={(element) => queueMicrotask(() => element.focus())}
              aria-label={language.t("quickEntry.placeholder")}
              placeholder={language.t("quickEntry.placeholder")}
              onInput={(event) => setState("text", event.currentTarget.value)}
            />
            <Show when={typeof platform.screenshot === "function"}>
              <IconButtonV2
                type="button"
                data-action="quick-entry-attach"
                variant="ghost-muted"
                size="normal"
                icon={<IconV2 name="monitor" />}
                aria-label={language.t("quickEntry.attach")}
                onClick={() => void attachScreenshot()}
              />
            </Show>
            <ButtonV2 type="submit" variant="neutral" size="normal" disabled={state.text.trim() === ""}>
              {language.t("quickEntry.send")}
            </ButtonV2>
          </Show>
          <IconButtonV2
            type="button"
            data-action="quick-entry-close"
            variant="ghost-muted"
            size="normal"
            icon={<IconV2 name="close" />}
            aria-label={language.t("common.close")}
            onClick={close}
          />
        </form>
      </div>
    </Show>
  )
}

function dataUrlMime(dataUrl: string) {
  if (!dataUrl.startsWith("data:")) return "image/png"
  const end = dataUrl.indexOf(";")
  if (end === -1) return "image/png"
  return dataUrl.slice(5, end) || "image/png"
}
