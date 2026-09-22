import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { createStore } from "solid-js/store"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { addDispatch, completeDispatch, type DispatchTask } from "./dispatch-store"

export function DispatchPanel() {
  const language = useLanguage()
  const layout = useLayout()
  const local = useLocal()
  const sdk = useSDK()
  const [state, setState] = createStore({
    text: "",
    sending: false,
    error: "",
    tasks: [] as DispatchTask[],
  })

  const send = async () => {
    const text = state.text.trim()
    const directory = layout.projects.list()[0]?.worktree
    if (!text || !directory || state.sending) return
    setState({ sending: true, error: "" })
    const model = local.model.current()
    const created = await sdk()
      .api.session.create({
        agent: "build",
        model: model ? { id: model.id, providerID: model.provider.id } : undefined,
        location: { directory },
      })
      .catch(() => undefined)
    if (!created?.id) {
      setState({ sending: false, error: language.t("dispatch.sendFailed") })
      return
    }
    setState("tasks", addDispatch(state.tasks, { sessionID: created.id, title: text, status: "running" }))
    await sdk()
      .api.session.prompt({
        sessionID: created.id,
        agent: "build",
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        text,
      })
      .then(
        () => setState("tasks", completeDispatch(state.tasks, created.id)),
        () => setState("error", language.t("dispatch.sendFailed")),
      )
    setState({ sending: false, text: "" })
  }

  return (
    <Dialog>
      <DialogTitle>{language.t("dispatch.title")}</DialogTitle>
      <div class="flex flex-col gap-3 p-4">
        <textarea
          class="min-h-24 w-full rounded border border-border-weak bg-surface-base p-2 text-14-regular"
          aria-label={language.t("dispatch.placeholder")}
          placeholder={language.t("dispatch.placeholder")}
          value={state.text}
          onInput={(event) => setState("text", event.currentTarget.value)}
        />
        <ButtonV2 disabled={state.sending || state.text.trim() === ""} onClick={() => void send()}>
          {language.t("dispatch.send")}
        </ButtonV2>
        <Show when={state.error}>
          <p class="text-text-critical">{state.error}</p>
        </Show>
        <ul class="flex flex-col gap-1">
          <For each={state.tasks}>
            {(task) => (
              <li class="truncate text-14-regular">
                {task.title} · {language.t(task.status === "running" ? "dispatch.running" : "dispatch.done")}
              </li>
            )}
          </For>
        </ul>
      </div>
    </Dialog>
  )
}
