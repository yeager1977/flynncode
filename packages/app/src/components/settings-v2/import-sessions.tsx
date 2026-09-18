import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import {
  buildOptions,
  clearVisible,
  selectAll,
  selectedCount,
  tally,
  toggleSelection,
  type ImportCandidate,
} from "./import-selection"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

type ImportSource = "claude-code" | "codex"

const sources: ImportSource[] = ["claude-code", "codex"]

const sourceKey = (source: ImportSource) =>
  source === "claude-code" ? "settings.import.source.claudeCode" : "settings.import.source.codex"

export const SettingsImportSessionsV2: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()

  const [source, setSource] = createSignal<ImportSource>("claude-code")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [importing, setImporting] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | undefined>()

  const directory = () => props.directory

  const [candidates, candidatesActions] = createResource(
    () => ({ source: source(), directory: directory() }),
    async (input) => {
      if (!input.directory) return [] as ImportCandidate[]
      // Swallow fetch failures so the errored resource is never read in a
      // render-tracked scope, which would crash the whole app.
      try {
        const result = await serverSdk().client.v2.import.sources(
          { source: input.source, directory: input.directory },
          { throwOnError: true },
        )
        setLoadError(undefined)
        return result.data.data
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
        return []
      }
    },
  )

  const options = createMemo(() => buildOptions(candidates() ?? [], query()))

  const selectable = createMemo(
    () => options().filter((option) => !option.disabled && selected().has(option.value.sourceSessionID)),
  )

  const chosen = createMemo(() => selectedCount(selected(), options()))

  const toggle = (id: string) => setSelected(toggleSelection(selected(), id))

  const selectAllVisible = () => setSelected(selectAll(selected(), options()))

  const clearVisibleSelection = () => setSelected(clearVisible(selected(), options()))

  const runImport = async () => {
    const pending = selectable()
    const target = directory()
    if (!target || pending.length === 0 || importing()) return
    setImporting(true)
    const results: boolean[] = []
    for (const option of pending) {
      try {
        await serverSdk().client.v2.import.fromSource(
          {
            source: source(),
            sourceSessionID: option.value.sourceSessionID,
            sourcePath: option.value.path,
            title: option.value.title,
            location: { directory: target },
          },
          { throwOnError: true },
        )
        results.push(true)
      } catch {
        results.push(false)
      }
      setSelected(toggleSelection(selected(), option.value.sourceSessionID))
    }
    setImporting(false)
    const counts = tally(results)
    showToast({
      variant: counts.failed > 0 ? "error" : "success",
      description: language.t("settings.import.summary", counts),
    })
    void candidatesActions.refetch()
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-plugins-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.import.title")}</h2>
          <div class="flex items-center gap-2">
            <Show when={chosen() > 0}>
              <span class="settings-v2-plugins-note">
                {language.t("settings.import.selected", { count: chosen() })}
              </span>
            </Show>
            <ButtonV2
              size="normal"
              variant="ghost-muted"
              disabled={importing() || options().length === 0}
              onClick={selectAllVisible}
            >
              {language.t("settings.import.selectAll")}
            </ButtonV2>
            <Show when={chosen() > 0}>
              <ButtonV2 size="normal" variant="ghost-muted" disabled={importing()} onClick={clearVisibleSelection}>
                {language.t("settings.import.clear")}
              </ButtonV2>
            </Show>
            <ButtonV2
              size="normal"
              variant="neutral"
              disabled={importing() || selectable().length === 0}
              onClick={() => void runImport()}
            >
              {importing() ? language.t("settings.import.importing") : language.t("settings.import.action")}
            </ButtonV2>
          </div>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-plugins">
        <div class="settings-v2-plugins-note">{language.t("settings.import.description")}</div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.import.source")}</h3>
          <div class="flex gap-2">
            <For each={sources}>
              {(item) => (
                <ButtonV2
                  size="normal"
                  variant={source() === item ? "neutral" : "ghost-muted"}
                  disabled={importing()}
                  onClick={() => setSource(item)}
                >
                  {language.t(sourceKey(item))}
                </ButtonV2>
              )}
            </For>
          </div>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.import.directory")}</h3>
          <div class="settings-v2-plugins-note">{directory() ?? "—"}</div>
        </div>

        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={language.t("settings.import.search")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("settings.import.search")}
          />
        </div>

        <Show
          when={!candidates.loading && options().length > 0}
          fallback={
            <div class="settings-v2-plugins-note">
              <Show when={!candidates.loading} fallback={<>{language.t("settings.import.loading")}</>}>
                <Show
                  when={!loadError()}
                  fallback={<>{language.t("settings.import.loadError")} {loadError()}</>}
                >
                  {language.t("settings.import.empty")}
                </Show>
              </Show>
            </div>
          }
        >
          <SettingsListV2>
            <For each={options()}>
              {(option) => (
                <div data-slot="settings-import-option" data-disabled={option.disabled ? "" : undefined}>
                  <CheckboxV2
                    checked={selected().has(option.value.sourceSessionID)}
                    disabled={option.disabled || importing()}
                    onChange={() => toggle(option.value.sourceSessionID)}
                    label={option.label}
                    description={
                      <>
                        <Show when={option.disabled}>
                          {language.t("settings.import.imported")}
                          {" · "}
                        </Show>
                        {option.value.cwd}
                      </>
                    }
                  />
                </div>
              )}
            </For>
          </SettingsListV2>
        </Show>
      </div>
    </>
  )
}