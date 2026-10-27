import { Tag } from "@flynncode/ui/v2/badge-v2"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Switch } from "@flynncode/ui/v2/switch-v2"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { claudeSourceRows, pendingCount, trustRows, type HookTrustRow } from "./hooks-payload"
import "./settings-v2.css"

const statusTagVariant = (status: HookTrustRow["status"]) => (status === "pending" ? "accent" : "neutral")

const statusKey = (status: HookTrustRow["status"]) =>
  status === "managed"
    ? "settings.hooks.status.managed"
    : status === "trusted"
      ? "settings.hooks.status.trusted"
      : "settings.hooks.status.pending"

const kindKey = (kind: "user" | "project" | "plugin") =>
  kind === "user"
    ? "settings.hooks.claude.kind.user"
    : kind === "project"
      ? "settings.hooks.claude.kind.project"
      : "settings.hooks.claude.kind.plugin"

const empty = { rows: [], claude: [], claudeWarnings: [], claudeDisabled: false, bypass: false }

export const SettingsHooksV2: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const [busy, setBusy] = createSignal<string | undefined>()
  const [loadError, setLoadError] = createSignal<string | undefined>()

  const query = () => (props.directory ? { directory: props.directory } : undefined)

  const [state, stateActions] = createResource(
    () => true,
    async () => {
      try {
        const sdk = serverSdk()
        const result = await sdk.client.config.hooks.trust.list(query())
        setLoadError(undefined)
        const sources = result.data?.claudeSources ?? []
        const rows = trustRows(result.data?.hooks ?? [], sources)
        return {
          rows,
          claude: claudeSourceRows(sources, rows),
          claudeWarnings: result.data?.claudeWarnings ?? [],
          claudeDisabled: result.data?.claudeDisabled ?? false,
          bypass: result.data?.bypass ?? false,
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
        return empty
      }
    },
  )

  const rows = createMemo(() => state()?.rows ?? [])
  const claude = createMemo(() => state()?.claude ?? [])
  const pending = createMemo(() => pendingCount(rows()))

  const act = async (hash: string, action: "approve" | "revoke") => {
    setBusy(hash)
    try {
      const sdk = serverSdk()
      if (action === "approve") {
        await sdk.client.config.hooks.trust.approve({ ...query(), hooksHashInput: { hash } })
      } else {
        await sdk.client.config.hooks.trust.revoke({ ...query(), hooksHashInput: { hash } })
      }
      await stateActions.refetch()
    } catch (error) {
      showToast({ variant: "error", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(id)
    try {
      const sdk = serverSdk()
      await sdk.client.config.hooks.claude.toggle({ ...query(), claudeHookToggleInput: { id, enabled } })
      await stateActions.refetch()
    } catch (error) {
      showToast({ variant: "error", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div class="flex w-full flex-col gap-4">
      <div>
        <div data-slot="settings-v2-panel-title">{language.t("settings.hooks.title")}</div>
        <div data-slot="settings-v2-panel-description">{language.t("settings.hooks.description")}</div>
      </div>
      <Show when={state()?.bypass}>
        <div data-slot="settings-v2-panel-description">{language.t("settings.hooks.bypass")}</div>
      </Show>
      <Show when={loadError() !== undefined}>
        <div data-slot="settings-v2-panel-description">{loadError()}</div>
      </Show>
      <Show when={state.loading}>
        <div data-slot="settings-v2-panel-description">{language.t("settings.hooks.loading")}</div>
      </Show>
      <Show when={!state.loading && rows().length === 0 && loadError() === undefined}>
        <div data-slot="settings-v2-panel-description">{language.t("settings.hooks.empty")}</div>
      </Show>
      <Show when={pending() > 0}>
        <div data-slot="settings-v2-panel-description">{language.plural("settings.hooks.pending", pending())}</div>
      </Show>
      <SettingsListV2>
        <For each={rows()}>
          {(row) => (
            <SettingsRowV2
              title={row.summary}
              description={[
                row.event,
                row.matcher,
                row.source && language.t("settings.hooks.source", { source: row.source }),
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <div class="flex items-center gap-2">
                <Tag variant={statusTagVariant(row.status)}>{language.t(statusKey(row.status))}</Tag>
                <Show when={row.status === "pending"}>
                  <ButtonV2
                    variant="neutral"
                    disabled={busy() === row.hash}
                    onClick={() => void act(row.hash, "approve")}
                  >
                    {language.t("settings.hooks.trust")}
                  </ButtonV2>
                </Show>
                <Show when={row.status === "trusted"}>
                  <ButtonV2
                    variant="neutral"
                    disabled={busy() === row.hash}
                    onClick={() => void act(row.hash, "revoke")}
                  >
                    {language.t("settings.hooks.revoke")}
                  </ButtonV2>
                </Show>
              </div>
            </SettingsRowV2>
          )}
        </For>
      </SettingsListV2>
      <div data-action="settings-hooks-claude" class="flex flex-col gap-2">
        <h3 class="settings-v2-section-title">{language.t("settings.hooks.claude.title")}</h3>
        <div data-slot="settings-v2-panel-description">{language.t("settings.hooks.claude.description")}</div>
        <Show when={state()?.claudeDisabled}>
          <div data-slot="settings-v2-panel-description">{language.t("settings.hooks.claude.disabledByEnv")}</div>
        </Show>
        <Show when={!state.loading && !state()?.claudeDisabled && claude().length === 0}>
          <div data-slot="settings-v2-panel-description">{language.t("settings.hooks.claude.empty")}</div>
        </Show>
        <For each={state()?.claudeWarnings ?? []}>
          {(warning) => <div data-slot="settings-v2-panel-description">{warning}</div>}
        </For>
        <SettingsListV2>
          <For each={claude()}>
            {(source) => (
              <SettingsRowV2
                title={source.label}
                description={
                  <div class="flex flex-col gap-1">
                    <div>
                      {[language.t(kindKey(source.kind)), source.events.join(", ")].filter(Boolean).join(" · ")}
                    </div>
                    <For each={source.commands}>
                      {(command) => <code class="text-12-regular text-text-base break-all">{command}</code>}
                    </For>
                    <For each={source.warnings}>{(warning) => <div>{warning}</div>}</For>
                  </div>
                }
              >
                <div class="flex items-center gap-2">
                  <Show when={source.enabled && source.pending > 0}>
                    <Tag variant="accent">{language.plural("settings.hooks.pending", source.pending)}</Tag>
                  </Show>
                  <Switch
                    checked={source.enabled}
                    disabled={busy() === source.id}
                    onChange={(checked) => void toggle(source.id, checked)}
                    hideLabel
                  >
                    {language.t("settings.hooks.claude.toggle", { source: source.label })}
                  </Switch>
                </div>
              </SettingsRowV2>
            )}
          </For>
        </SettingsListV2>
      </div>
    </div>
  )
}
