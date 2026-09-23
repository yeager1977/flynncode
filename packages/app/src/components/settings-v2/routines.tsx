import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { addRoutine, removeRoutine, routinesFromConfig, routinesToConfig, toggleRoutine } from "./routines-edit"

export function SettingsRoutinesV2() {
  const language = useLanguage()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const layout = useLayout()
  const [draft, setDraft] = createStore({ name: "", prompt: "", dailyAt: "", error: "", saving: false })
  const routines = createMemo(() => routinesFromConfig(serverSync().data.config.routines))
  const directory = createMemo(() => layout.projects.list()[0]?.worktree ?? "")

  const save = async (next: ReturnType<typeof routinesFromConfig>) => {
    setDraft("saving", true)
    setDraft("error", "")
    await serverSync()
      .updateConfig({ routines: routinesToConfig(next) })
      .catch(() => setDraft("error", language.t("settings.routines.saveFailed")))
    setDraft("saving", false)
  }

  const create = () => {
    if (!draft.name.trim() || !draft.prompt.trim()) return
    if (draft.dailyAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.dailyAt)) {
      setDraft("error", language.t("settings.routines.timeInvalid"))
      return
    }
    void save(addRoutine(routines(), { name: draft.name, prompt: draft.prompt, dailyAt: draft.dailyAt || undefined }))
    setDraft({ name: "", prompt: "", dailyAt: "" })
  }

  const run = async (id: string) => {
    const routine = routines().find((item) => item.id === id)
    const dir = directory()
    if (!routine || !dir) return
    const agent = "build"
    const created = await serverSDK()
      .api.session.create({ agent, location: { directory: dir } })
      .catch(() => undefined)
    if (!created?.id) {
      setDraft("error", language.t("settings.routines.runFailed"))
      return
    }
    await serverSDK()
      .api.session.prompt({ sessionID: created.id, agent, text: routine.prompt })
      .catch(() => setDraft("error", language.t("settings.routines.runFailed")))
  }

  return (
    <div class="settings-v2-tab-body flex flex-col gap-4 p-4">
      <div>
        <h2 class="settings-v2-tab-title">{language.t("settings.routines.title")}</h2>
        <p class="text-text-weak">{language.t("settings.routines.description")}</p>
      </div>
      <div class="flex flex-col gap-2">
        <input
          class="rounded border border-border-weak bg-surface-base px-2 py-1 text-14-regular"
          aria-label={language.t("settings.routines.name")}
          placeholder={language.t("settings.routines.name")}
          value={draft.name}
          onInput={(event) => setDraft("name", event.currentTarget.value)}
        />
        <textarea
          class="min-h-20 rounded border border-border-weak bg-surface-base p-2 text-14-regular"
          aria-label={language.t("settings.routines.prompt")}
          placeholder={language.t("settings.routines.prompt")}
          value={draft.prompt}
          onInput={(event) => setDraft("prompt", event.currentTarget.value)}
        />
        <input
          class="rounded border border-border-weak bg-surface-base px-2 py-1 text-14-regular"
          aria-label={language.t("settings.routines.time")}
          placeholder={language.t("settings.routines.time")}
          value={draft.dailyAt}
          onInput={(event) => setDraft("dailyAt", event.currentTarget.value)}
        />
        <ButtonV2 disabled={draft.saving || !draft.name.trim() || !draft.prompt.trim()} onClick={create}>
          {language.t("settings.routines.add")}
        </ButtonV2>
      </div>
      <Show when={draft.error}>
        <p class="text-text-critical">{draft.error}</p>
      </Show>
      <ul class="flex flex-col gap-2">
        <For each={routines()}>
          {(routine) => (
            <li class="flex items-center gap-3 rounded border border-border-weak p-2">
              <div class="min-w-0 flex-1">
                <div class="truncate text-14-medium">{routine.name}</div>
                <div class="truncate text-12-regular text-text-weak" dir="ltr">
                  {routine.dailyAt ?? language.t("settings.routines.manual")}
                  {routine.lastRun ? ` · ${routine.lastRun}` : ""}
                </div>
              </div>
              <Switch
                checked={routine.enabled}
                hideLabel
                onChange={() => void save(toggleRoutine(routines(), routine.id))}
              >
                {routine.name}
              </Switch>
              <ButtonV2 size="small" variant="ghost" onClick={() => void run(routine.id)}>
                {language.t("settings.routines.run")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" onClick={() => void save(removeRoutine(routines(), routine.id))}>
                {language.t("settings.routines.delete")}
              </ButtonV2>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
