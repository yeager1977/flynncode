import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { pendingCount, trustRows, type HookTrustRow } from "./hooks-payload"
import "./settings-v2.css"

const statusTagVariant = (status: HookTrustRow["status"]) => (status === "pending" ? "accent" : "neutral")

const statusKey = (status: HookTrustRow["status"]) =>
  status === "managed" ? "settings.hooks.status.managed" : status === "trusted" ? "settings.hooks.status.trusted" : "settings.hooks.status.pending"

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
        return { rows: trustRows(result.data?.hooks ?? []), bypass: result.data?.bypass ?? false }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
        return { rows: [], bypass: false }
      }
    },
  )

  const rows = createMemo(() => state()?.rows ?? [])
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
      <Show when={rows().length === 0 && loadError() === undefined}>
        <div data-slot="settings-v2-panel-description">{language.t("settings.hooks.empty")}</div>
      </Show>
      <Show when={pending() > 0}>
        <div data-slot="settings-v2-panel-description">
          {language.t("settings.hooks.pending", { count: String(pending()) })}
        </div>
      </Show>
      <SettingsListV2>
        <For each={rows()}>
          {(row) => (
            <SettingsRowV2
              title={row.summary}
              description={`${row.event}${row.matcher ? ` · ${row.matcher}` : ""}`}
            >
              <div class="flex items-center gap-2">
                <Tag variant={statusTagVariant(row.status)}>{language.t(statusKey(row.status))}</Tag>
                <Show when={row.status === "pending"}>
                  <ButtonV2 variant="neutral" disabled={busy() === row.hash} onClick={() => void act(row.hash, "approve")}>
                    {language.t("settings.hooks.trust")}
                  </ButtonV2>
                </Show>
                <Show when={row.status === "trusted"}>
                  <ButtonV2 variant="neutral" disabled={busy() === row.hash} onClick={() => void act(row.hash, "revoke")}>
                    {language.t("settings.hooks.revoke")}
                  </ButtonV2>
                </Show>
              </div>
            </SettingsRowV2>
          )}
        </For>
      </SettingsListV2>
    </div>
  )
}
