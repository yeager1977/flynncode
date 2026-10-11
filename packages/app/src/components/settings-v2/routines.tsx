import { useDialog } from "@flynncode/ui/context/dialog"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@flynncode/ui/v2/dialog-v2"
import { DividerV2 } from "@flynncode/ui/v2/divider-v2"
import { Switch } from "@flynncode/ui/v2/switch-v2"
import { TextInputV2 } from "@flynncode/ui/v2/text-input-v2"
import { TextareaV2 } from "@flynncode/ui/v2/textarea-v2"
import { For, Show, createMemo, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { addRoutine, isValidRrule, removeRoutine, routinesFromConfig, routinesToConfig, toggleRoutine, updateRoutine, type StoredRoutine, type StoredRoutineRun } from "./routines-edit"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

export const SettingsRoutinesV2: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const [draft, setDraft] = createStore({
    editingId: "",
    name: "",
    prompt: "",
    dailyAt: "",
    interval: "",
    rrule: "",
    targetUrl: "",
    targetUser: "",
    targetPass: "",
    error: "",
    saving: false,
  })
  const routines = createMemo(() => routinesFromConfig(serverSync().data.config.routines))
  // Full run history lives in the server's runs file (capped at 200, while
  // recentRuns keeps only the last 10); prefer it and fall back to the config
  // snapshot when the server request fails.
  const [runHistory, setRunHistory] = createStore<Record<string, StoredRoutineRun[]>>({})

  onMount(() => {
    void serverSDK()
      .client.global.routinesRuns()
      .then((response) => {
        if (!response.data) return
        setRunHistory(
          response.data.reduce<Record<string, StoredRoutineRun[]>>((acc, run) => {
            (acc[run.routineId] ??= []).push(run)
            return acc
          }, {}),
        )
      })
      .catch(() => undefined)
  })

  const save = async (next: ReturnType<typeof routinesFromConfig>) => {
    setDraft({ saving: true, error: "" })
    const ok = await serverSync()
      .updateConfig({ routines: routinesToConfig(next) })
      .then(() => true)
      .catch(() => false)
    setDraft({ saving: false, error: ok ? "" : language.t("settings.routines.saveFailed") })
    return ok
  }

  const resetDraft = () =>
    setDraft({ editingId: "", name: "", prompt: "", dailyAt: "", interval: "", rrule: "", targetUrl: "", targetUser: "", targetPass: "", error: "" })

  const draftScheduleError = () => {
    if (draft.rrule && !isValidRrule(draft.rrule)) return "settings.routines.rruleInvalid"
    if (draft.dailyAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.dailyAt)) return "settings.routines.timeInvalid"
    if (draft.interval && !["15m", "1h", "6h", "1d", "1w"].includes(draft.interval))
      return "settings.routines.intervalInvalid"
    return ""
  }

  const create = async () => {
    if (!draft.name.trim() || !draft.prompt.trim()) return
    const errorKey = draftScheduleError()
    if (errorKey) {
      setDraft("error", language.t(errorKey))
      return
    }
    const ok = await save(
      addRoutine(routines(), {
        name: draft.name,
        prompt: draft.prompt,
        dailyAt: draft.rrule ? undefined : draft.dailyAt || undefined,
        interval: draft.rrule || draft.dailyAt ? undefined : draft.interval || undefined,
        rrule: draft.rrule || undefined,
        targetUrl: draft.targetUrl || undefined,
        targetUser: draft.targetUser || undefined,
        targetPass: draft.targetPass || undefined,
      }),
    )
    // Keep the draft on failure so the user can retry without retyping.
    if (ok) resetDraft()
  }

  const startEdit = (routine: StoredRoutine) =>
    setDraft({
      editingId: routine.id,
      name: routine.name,
      prompt: routine.prompt,
      dailyAt: routine.dailyAt ?? "",
      interval: routine.interval ?? "",
      rrule: routine.rrule ?? "",
      // The stored password is never echoed into the form; a save that leaves
      // the password row blank keeps it.
      targetUrl: routine.target?.url ?? "",
      targetUser: routine.target?.username ?? "",
      targetPass: "",
      error: "",
    })

  // updateRoutine enforces the same one-of schedule precedence as addRoutine,
  // so passing every draft field is safe: the winning field clears the rest.
  const update = async () => {
    if (!draft.editingId || !draft.name.trim() || !draft.prompt.trim()) return
    const errorKey = draftScheduleError()
    if (errorKey) {
      setDraft("error", language.t(errorKey))
      return
    }
    const ok = await save(
      updateRoutine(routines(), draft.editingId, {
        name: draft.name,
        prompt: draft.prompt,
        dailyAt: draft.dailyAt || undefined,
        interval: draft.interval || undefined,
        rrule: draft.rrule || undefined,
        targetUrl: draft.targetUrl,
        targetUser: draft.targetUser,
        targetPass: draft.targetPass,
      }),
    )
    if (ok) resetDraft()
  }

  // Runs in the project the settings dialog was opened from, never a guessed one.
  const run = async (id: string) => {
    const routine = routines().find((item) => item.id === id)
    if (!routine || !props.directory) return
    const agent = "build"
    const created = await serverSDK()
      .api.session.create({ agent, location: { directory: props.directory } })
      .catch(() => undefined)
    const ok =
      created?.id !== undefined &&
      (await serverSDK()
        .api.session.prompt({ sessionID: created.id, agent, text: routine.prompt })
        .then(() => true)
        .catch(() => false))
    showToast(
      ok
        ? { variant: "success", description: language.t("settings.routines.runStarted", { name: routine.name }) }
        : { variant: "error", description: language.t("settings.routines.runFailed") },
    )
  }

  const confirmDelete = (routine: { id: string; name: string }) => {
    void dialog.push(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup
            title={language.t("settings.routines.deleteConfirm.title")}
            description={language.t("settings.routines.deleteConfirm.body", { name: routine.name })}
          />
        </DialogHeader>
        <DividerV2 />
        <DialogFooter>
          <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="danger"
            onClick={() => {
              dialog.close()
              void save(removeRoutine(routines(), routine.id))
            }}
          >
            {language.t("settings.routines.delete")}
          </ButtonV2>
        </DialogFooter>
      </Dialog>
    ))
  }

  return (
    <div class="settings-v2-tab-body flex flex-col gap-4 p-4">
      <div>
        <h2 class="settings-v2-tab-title">{language.t("settings.routines.title")}</h2>
        <p class="text-text-weak">{language.t("settings.routines.description")}</p>
      </div>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.routines.name")}
          description={language.t("settings.routines.nameDescription")}
        >
          <TextInputV2
            type="text"
            aria-label={language.t("settings.routines.name")}
            value={draft.name}
            onInput={(event) => setDraft("name", event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.routines.prompt")}
          description={language.t("settings.routines.promptDescription")}
        >
          <TextareaV2
            aria-label={language.t("settings.routines.prompt")}
            value={draft.prompt}
            onInput={(event) => setDraft("prompt", event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.routines.time")}
          description={language.t("settings.routines.timeDescription")}
        >
          <TextInputV2
            type="text"
            dir="ltr"
            aria-label={language.t("settings.routines.time")}
            value={draft.dailyAt}
            onInput={(event) => setDraft("dailyAt", event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.routines.interval")}
          description={language.t("settings.routines.intervalDescription")}
        >
          <TextInputV2
            type="text"
            dir="ltr"
            aria-label={language.t("settings.routines.interval")}
            value={draft.interval}
            onInput={(event) => setDraft("interval", event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.routines.rrule")}
          description={language.t("settings.routines.rruleDescription")}
        >
          <TextInputV2
            type="text"
            dir="ltr"
            aria-label={language.t("settings.routines.rrule")}
            value={draft.rrule}
            onInput={(event) => setDraft("rrule", event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.routines.targetUrl")}
          description={language.t("settings.routines.targetUrlDescription")}
        >
          <TextInputV2
            type="text"
            dir="ltr"
            aria-label={language.t("settings.routines.targetUrl")}
            placeholder="http://"
            value={draft.targetUrl}
            onInput={(event) => setDraft("targetUrl", event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.routines.targetUsername")}
          description={language.t("settings.routines.targetUsernameDescription")}
        >
          <TextInputV2
            type="text"
            aria-label={language.t("settings.routines.targetUsername")}
            value={draft.targetUser}
            onInput={(event) => setDraft("targetUser", event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.routines.targetPassword")}
          description={language.t("settings.routines.targetPasswordDescription")}
        >
          <TextInputV2
            type="password"
            aria-label={language.t("settings.routines.targetPassword")}
            value={draft.targetPass}
            onInput={(event) => setDraft("targetPass", event.currentTarget.value)}
          />
        </SettingsRowV2>
      </SettingsListV2>
      <p class="text-12-regular text-text-weak">{language.t("settings.routines.targetDescription")}</p>
      <div class="flex gap-2">
        <Show
          when={draft.editingId}
          fallback={
            <ButtonV2
              disabled={draft.saving || !draft.name.trim() || !draft.prompt.trim()}
              onClick={() => void create()}
            >
              {language.t("settings.routines.add")}
            </ButtonV2>
          }
        >
          <ButtonV2
            disabled={draft.saving || !draft.name.trim() || !draft.prompt.trim()}
            onClick={() => void update()}
          >
            {language.t("settings.routines.save")}
          </ButtonV2>
          <ButtonV2 variant="ghost" disabled={draft.saving} onClick={resetDraft}>
            {language.t("common.cancel")}
          </ButtonV2>
        </Show>
      </div>
      <Show when={draft.error}>
        <p class="text-text-critical">{draft.error}</p>
      </Show>
      <Show when={!props.directory && routines().length > 0}>
        <p class="text-text-weak">{language.t("settings.routines.noProject")}</p>
      </Show>
      <ul class="flex flex-col gap-2">
        <For each={routines()}>
          {(routine) => (
            <li class="flex items-center gap-3 rounded border border-border-weak p-2">
              <div class="min-w-0 flex-1">
                <div class="truncate text-14-medium">{routine.name}</div>
                <div class="truncate text-12-regular text-text-weak" dir="ltr">
                  {routine.rrule ?? routine.dailyAt ?? routine.interval ?? language.t("settings.routines.manual")}
                  {routine.lastRun ? ` · ${routine.lastRun}` : ""}
                </div>
                <Show when={(runHistory[routine.id] ?? routine.recentRuns)?.length}>
                  <div class="text-12-regular text-text-weak">{language.t("settings.routines.history")}</div>
                  <ul class="flex flex-col gap-1">
                    <For each={runHistory[routine.id] ?? routine.recentRuns ?? []}>
                      {(run) => (
                        <li class="truncate text-12-regular text-text-weak" dir="ltr">
                          {run.startedAt} ·{" "}
                          {run.state === "ok"
                            ? language.t("settings.routines.runOk")
                            : language.t("settings.routines.runError")}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
              <Switch
                checked={routine.enabled}
                hideLabel
                onChange={() => void save(toggleRoutine(routines(), routine.id))}
              >
                {routine.name}
              </Switch>
              <ButtonV2
                size="small"
                variant="ghost"
                disabled={!props.directory}
                title={props.directory ? undefined : language.t("settings.routines.noProject")}
                onClick={() => void run(routine.id)}
              >
                {language.t("settings.routines.run")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" disabled={draft.saving} onClick={() => startEdit(routine)}>
                {language.t("settings.routines.edit")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" disabled={draft.saving} onClick={() => confirmDelete(routine)}>
                {language.t("settings.routines.delete")}
              </ButtonV2>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
