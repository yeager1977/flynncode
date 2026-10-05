import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { worktreeFromConfig, worktreeToConfig, worktreeValidationErrors, type WorktreeForm } from "./worktree-payload"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const emptyForm: WorktreeForm = { location: "", branchPrefix: "", keep: "" }

export const SettingsWorktreeV2: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()

  const [store, setStore] = createStore({
    scope: "project" as "global" | "project",
    loading: false,
    saving: false,
    error: "",
    saved: false,
    form: worktreeFromConfig(serverSync().data.config),
    formBaseline: JSON.stringify(worktreeFromConfig(serverSync().data.config)),
    projectForm: undefined as WorktreeForm | undefined,
    projectBaseline: undefined as string | undefined,
  })

  const form = () => (store.scope === "project" ? (store.projectForm ?? emptyForm) : store.form)
  const baseline = () => (store.scope === "project" ? store.projectBaseline : store.formBaseline)
  const dirty = () => baseline() !== undefined && JSON.stringify(form()) !== baseline()
  const errors = () => worktreeValidationErrors(form())
  const fieldError = (field: "keep" | "location") => errors().includes(field)

  // The worktree fields are project-scoped (location resolves relative to the
  // project root), so project mode is the default; global mode is an explicit
  // opt-in through the toggle.
  const loadProject = async () => {
    if (!props.directory) return
    setStore("loading", true)
    try {
      const response = await serverSdk().client.config.get({ directory: props.directory })
      const project = worktreeFromConfig((response.data ?? {}) as Config)
      setStore({ projectForm: project, projectBaseline: JSON.stringify(project), error: "" })
    } catch {
      setStore("error", language.t("settings.worktree.loadFailed"))
    } finally {
      setStore("loading", false)
    }
  }

  const switchScope = (scope: "global" | "project") => {
    setStore({ scope, saved: false, error: "" })
    if (scope === "project" && store.projectForm === undefined) void loadProject()
  }

  const setField = (field: keyof WorktreeForm, value: string) => {
    setStore("saved", false)
    if (store.scope === "project" && store.projectForm) setStore("projectForm", field, value)
    else if (store.scope === "global") setStore("form", field, value)
  }

  const saveScope = async () => {
    if (store.saving) return
    const draft = store.scope === "project" ? store.projectForm : store.form
    if (!draft || worktreeValidationErrors(draft).length > 0) return
    setStore({ saving: true, error: "", saved: false })
    const patch = worktreeToConfig(draft)
    try {
      // Both scopes rewrite the parsed config of the file they save: reading
      // first and setting/clearing only `worktree` keeps every other key.
      if (store.scope === "project") {
        const response = await serverSdk().client.config.get({ directory: props.directory })
        const next = { ...((response.data ?? {}) as Config), ...patch }
        if (!patch.worktree) delete (next as Record<string, unknown>).worktree
        await serverSdk().client.config.update({ directory: props.directory, config: next })
        const saved = worktreeFromConfig(next)
        setStore({ projectForm: saved, projectBaseline: JSON.stringify(saved) })
      } else {
        const next = { ...serverSync().data.config, ...patch }
        if (!patch.worktree) delete (next as Record<string, unknown>).worktree
        await serverSync().updateConfig(next)
        const saved = worktreeFromConfig(next)
        setStore({ form: saved, formBaseline: JSON.stringify(saved) })
      }
      setStore("saved", true)
    } catch {
      setStore("error", language.t("settings.worktree.saveFailed"))
    } finally {
      setStore("saving", false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.worktree.title")}</h2>
      </div>
      <div class="settings-v2-tab-body flex flex-col gap-4">
        <p class="text-text-weak">{language.t("settings.worktree.description")}</p>

        <Show when={props.directory}>
          <div class="flex items-center gap-2">
            <Switch
              checked={store.scope === "global"}
              onChange={(checked) => switchScope(checked ? "global" : "project")}
            >
              {language.t("settings.worktree.globalToggle")}
            </Switch>
          </div>
        </Show>

        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.worktree.location")}
            description={language.t("settings.worktree.locationDescription")}
          >
            <TextInputV2
              type="text"
              dir="ltr"
              aria-label={language.t("settings.worktree.location")}
              placeholder={language.t("settings.worktree.locationPlaceholder")}
              value={form().location}
              onInput={(event) => setField("location", event.currentTarget.value)}
            />
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.worktree.branchPrefix")}
            description={language.t("settings.worktree.branchPrefixDescription")}
          >
            <TextInputV2
              type="text"
              dir="ltr"
              aria-label={language.t("settings.worktree.branchPrefix")}
              placeholder={language.t("settings.worktree.branchPrefixPlaceholder")}
              value={form().branchPrefix}
              onInput={(event) => setField("branchPrefix", event.currentTarget.value)}
            />
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.worktree.keep")}
            description={language.t("settings.worktree.keepDescription")}
          >
            <TextInputV2
              type="text"
              inputmode="numeric"
              dir="ltr"
              aria-label={language.t("settings.worktree.keep")}
              placeholder={language.t("settings.worktree.keepPlaceholder")}
              class={fieldError("keep") ? "text-text-critical" : undefined}
              value={form().keep}
              onInput={(event) => setField("keep", event.currentTarget.value)}
            />
          </SettingsRowV2>
        </SettingsListV2>

        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-3">
            <ButtonV2
              disabled={store.saving || store.loading || !dirty() || errors().length > 0}
              onClick={() => void saveScope()}
            >
              {language.t("settings.worktree.save")}
            </ButtonV2>
            <Show when={store.saved}>
              <span class="text-text-weak">{language.t("settings.worktree.saved")}</span>
            </Show>
          </div>
          <Show when={fieldError("keep")}>
            <span class="text-text-critical">{language.t("settings.worktree.keepInvalid")}</span>
          </Show>
          <Show when={fieldError("location")}>
            <span class="text-text-critical">{language.t("settings.worktree.locationInvalid")}</span>
          </Show>
          <Show when={store.error}>
            <span class="text-text-critical">{store.error}</span>
          </Show>
        </div>
      </div>
    </>
  )
}