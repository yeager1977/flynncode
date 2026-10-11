import { For, Show, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Switch } from "@flynncode/ui/v2/switch-v2"
import { TextInputV2 } from "@flynncode/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { previewFromConfig, previewToConfig, type PreviewForm } from "./preview-payload"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type ServerDraft = PreviewForm["servers"][number]

export const SettingsPreviewV2: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()

  const [store, setStore] = createStore({
    scope: (props.directory ? "project" : "global") as "global" | "project",
    loading: false,
    saving: false,
    error: "",
    saved: false,
    form: previewFromConfig(serverSync().data.config),
    formBaseline: JSON.stringify(previewFromConfig(serverSync().data.config)),
    projectForm: undefined as PreviewForm | undefined,
    projectBaseline: undefined as string | undefined,
  })

  const form = () => (store.scope === "project" ? (store.projectForm ?? store.form) : store.form)
  const baseline = () => (store.scope === "project" ? store.projectBaseline : store.formBaseline)
  const dirty = () => baseline() !== undefined && JSON.stringify(form()) !== baseline()

  const loadProject = async () => {
    if (!props.directory) return
    setStore("loading", true)
    try {
      const response = await serverSdk().client.config.project.get({ directory: props.directory })
      const project = previewFromConfig((response.data ?? {}) as Parameters<typeof previewFromConfig>[0])
      setStore({ projectForm: project, projectBaseline: JSON.stringify(project), error: "" })
    } catch {
      setStore("error", language.t("preview.settings.loadFailed"))
    } finally {
      setStore("loading", false)
    }
  }

  onMount(() => {
    if (props.directory) void loadProject()
  })

  const switchScope = (scope: "global" | "project") => {
    setStore({ scope, saved: false, error: "" })
    if (scope === "project" && store.projectForm === undefined) void loadProject()
  }

  const draft = (mutate: (current: PreviewForm) => PreviewForm) => {
    setStore("saved", false)
    if (store.scope === "project" && store.projectForm) setStore("projectForm", mutate(store.projectForm))
    else setStore("form", mutate(store.form))
  }

  const setServerField = (index: number, field: keyof ServerDraft, value: string) =>
    draft((current) => ({
      ...current,
      servers: current.servers.map((server, i) =>
        i === index ? { ...server, [field]: value.trim() === "" ? undefined : value } : server,
      ),
    }))

  const addServer = () =>
    draft((current) => ({ ...current, servers: [...current.servers, { name: "", command: "" }] }))

  const removeServer = (index: number) =>
    draft((current) => ({ ...current, servers: current.servers.filter((_, i) => i !== index) }))

  const setAutoVerify = (value: boolean) => draft((current) => ({ ...current, autoVerify: value }))

  const setNativeHost = (value: boolean) => draft((current) => ({ ...current, nativeHost: value }))

  const save = async () => {
    if (store.saving || !dirty()) return
    setStore({ saving: true, error: "", saved: false })
    const next = form()
    try {
      // Both scopes send only `preview`; the server patches that key into the
      // scope's config file and leaves every other key untouched.
      if (store.scope === "project") {
        await serverSdk().client.config.update({ directory: props.directory, config: previewToConfig(next) })
      } else {
        await serverSync().updateConfig(previewToConfig(next))
      }
      const serialized = JSON.stringify(next)
      if (store.scope === "project") setStore({ projectBaseline: serialized, saved: true })
      else setStore({ formBaseline: serialized, saved: true })
    } catch {
      setStore("error", language.t("preview.settings.saveFailed"))
    } finally {
      setStore("saving", false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("preview.settings.title")}</h2>
      </div>
      <div class="settings-v2-tab-body flex flex-col gap-4">
        <p class="text-text-weak">{language.t("preview.settings.description")}</p>

        <Show when={props.directory}>
          <div class="flex items-center gap-2">
            <Switch
              checked={store.scope === "global"}
              onChange={(checked) => switchScope(checked ? "global" : "project")}
            >
              {language.t("preview.settings.globalToggle")}
            </Switch>
          </div>
        </Show>

        <SettingsListV2>
          <SettingsRowV2 title={language.t("preview.settings.autoVerify")} description={language.t("preview.settings.autoVerifyDescription")}>
            <Switch checked={form().autoVerify} onChange={(checked) => setAutoVerify(checked)} />
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("preview.settings.nativeHost")}
            description={language.t("preview.settings.nativeHostDescription")}
          >
            <Switch checked={form().nativeHost} onChange={(checked) => setNativeHost(checked)} />
          </SettingsRowV2>
          <For each={form().servers}>
            {(server, index) => (
              <SettingsRowV2
                title={String(server.name ?? "") || language.t("preview.server.unnamed")}
                description={language.t("preview.server.description")}
              >
                <div class="flex flex-col gap-2">
                  <TextInputV2
                    type="text"
                    dir="ltr"
                    aria-label={language.t("preview.server.namePlaceholder")}
                    placeholder={language.t("preview.server.namePlaceholder")}
                    value={String(server.name ?? "")}
                    onInput={(event) => setServerField(index(), "name", event.currentTarget.value)}
                  />
                  <TextInputV2
                    type="text"
                    dir="ltr"
                    aria-label={language.t("preview.server.commandPlaceholder")}
                    placeholder={language.t("preview.server.commandPlaceholder")}
                    value={String(server.command ?? "")}
                    onInput={(event) => setServerField(index(), "command", event.currentTarget.value)}
                  />
                  <TextInputV2
                    type="text"
                    dir="ltr"
                    aria-label={language.t("preview.server.urlPlaceholder")}
                    placeholder={language.t("preview.server.urlPlaceholder")}
                    value={String(server.url ?? "")}
                    onInput={(event) => setServerField(index(), "url", event.currentTarget.value)}
                  />
                  <div class="flex items-center gap-2">
                    <ButtonV2 size="small" variant="neutral" onClick={() => removeServer(index())}>
                      {language.t("preview.server.remove")}
                    </ButtonV2>
                  </div>
                </div>
              </SettingsRowV2>
            )}
          </For>
        </SettingsListV2>

        <div class="flex items-center gap-2">
          <ButtonV2 size="small" variant="neutral" onClick={addServer}>
            {language.t("preview.server.add")}
          </ButtonV2>
          <ButtonV2 size="small" variant="contrast" disabled={!dirty() || store.saving} onClick={() => void save()}>
            {language.t("common.save")}
          </ButtonV2>
        </div>
        <Show when={store.error}>
          <p class="text-text-critical">{store.error}</p>
        </Show>
        <Show when={store.saved}>
          <p class="text-text-weak">{language.t("preview.settings.saved")}</p>
        </Show>
      </div>
    </>
  )
}
