import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { MachineSyncPairingCode, MachineSyncPrefsChoice, MachineSyncStatus } from "@/context/machine-sync-types"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { syncHeadline, syncNowFailed, syncPairNotice, syncProblem } from "./sync-card-status"

const PAIR_FAILURE_KEYS = {
  unreachable: "server.sync.pairFailed.unreachable",
  "invalid-code": "server.sync.pairFailed.invalid-code",
  failed: "server.sync.pairFailed.failed",
} as const

const PREFS_OPTIONS = [
  { id: "keep", label: "server.sync.prefs.keep" },
  { id: "theirs", label: "server.sync.prefs.theirs" },
] as const satisfies ReadonlyArray<{ id: MachineSyncPrefsChoice; label: string }>

export const SyncCard: Component = () => {
  const language = useLanguage()
  const api = usePlatform().machineSync
  const [state, setState] = createStore({
    status: undefined as MachineSyncStatus | undefined,
    code: undefined as MachineSyncPairingCode | undefined,
    host: "",
    pairCode: "",
    prefs: "keep" as MachineSyncPrefsChoice,
    pairFailure: undefined as keyof typeof PAIR_FAILURE_KEYS | undefined,
    pairNotice: undefined as ReturnType<typeof syncPairNotice>,
    pairing: false,
  })

  onMount(() => {
    if (!api) return
    void api
      .status()
      .then((status) => setState("status", status))
      .catch(() => undefined)
    onCleanup(api.subscribe((status) => setState("status", status)))
  })

  const showCode = () => {
    void api
      ?.createPairingCode()
      .then((code) => setState("code", code))
      .catch(() => undefined)
  }
  const pair = () => {
    const host = state.host.trim()
    const code = state.pairCode.trim()
    if (!api || !host || !code) return
    setState({ pairing: true, pairFailure: undefined, pairNotice: undefined })
    void api
      .pair({ host, code, prefs: state.prefs })
      .then((result) => {
        if (result.ok) {
          setState({ pairing: false, host: "", pairCode: "", code: undefined, pairNotice: syncPairNotice(result) })
          return
        }
        setState({ pairing: false, pairFailure: result.reason })
      })
      .catch(() => setState({ pairing: false, pairFailure: "failed" }))
  }
  const syncNow = () => {
    void api
      ?.syncNow()
      .then((status) => {
        setState("status", status)
        if (syncNowFailed(status)) showToast({ variant: "error", description: language.t("server.sync.toast.failed") })
      })
      .catch(() => undefined)
  }
  const togglePause = () => {
    void api?.setPaused(!state.status?.paused)
  }
  const unpair = () => {
    setState("pairNotice", undefined)
    void api?.unpair()
  }

  const headline = (status: MachineSyncStatus) => {
    const line = syncHeadline(status)
    if (line.key === "server.sync.unpaired") return language.t(line.key)
    return language.t(line.key, { name: line.name })
  }
  const problem = (status: MachineSyncStatus) => {
    const found = syncProblem(status)
    if (!found) return undefined
    if (found.key === "server.sync.error.failures") return language.t(found.key, { count: found.count })
    if (found.key === "server.sync.error.other") return language.t(found.key, { error: found.error })
    return language.t(found.key)
  }
  const lastSync = (status: MachineSyncStatus) =>
    status.lastSuccess === null
      ? language.t("server.sync.never")
      : language.t("server.sync.lastSync", { time: new Date(status.lastSuccess).toLocaleString() })

  return (
    <Show when={api && state.status}>
      {(status) => (
        <SettingsListV2>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div
                aria-hidden="true"
                classList={{
                  "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
                  "bg-icon-success-base": status().online,
                  "bg-border-weak-base": !status().online,
                }}
              />
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{language.t("server.sync.title")}</span>
                <span class="settings-v2-servers-meta">{headline(status())}</span>
              </div>
            </div>
          </div>
          <Show when={status().gatewayError}>
            {(error) => (
              <div class="settings-v2-servers-row">
                <span class="settings-v2-servers-meta settings-v2-servers-meta--wrap">
                  {language.t("server.sync.gatewayError", { error: error() })}
                </span>
              </div>
            )}
          </Show>
          <Show
            when={status().paired}
            fallback={
              <>
                <div class="settings-v2-servers-row">
                  <div class="settings-v2-servers-lead">
                    <div class="settings-v2-servers-copy">
                      <Show when={state.code}>
                        {(code) => (
                          <>
                            <span class="settings-v2-servers-name font-mono select-all">
                              {language.t("server.sync.code.value", { code: code().code })}
                            </span>
                            <span class="settings-v2-servers-meta settings-v2-servers-meta--wrap">
                              {language.t("server.sync.code.hint", {
                                name: code().machineName,
                                addresses: code().addresses.join(", "),
                              })}
                            </span>
                          </>
                        )}
                      </Show>
                    </div>
                  </div>
                  <div class="settings-v2-servers-actions">
                    <ButtonV2 size="small" variant="ghost-muted" onClick={showCode}>
                      {language.t("server.sync.code.show")}
                    </ButtonV2>
                  </div>
                </div>
                <div class="settings-v2-servers-row">
                  <div class="settings-v2-servers-lead">
                    <TextInputV2
                      appearance="base"
                      value={state.host}
                      onInput={(event) => setState("host", event.currentTarget.value)}
                      placeholder={language.t("server.sync.host.placeholder")}
                      spellcheck={false}
                      autocorrect="off"
                      autocomplete="off"
                      autocapitalize="off"
                      aria-label={language.t("server.sync.host.label")}
                    />
                    <TextInputV2
                      appearance="base"
                      value={state.pairCode}
                      onInput={(event) => setState("pairCode", event.currentTarget.value)}
                      placeholder={language.t("server.sync.pairCode.placeholder")}
                      inputMode="numeric"
                      autocomplete="off"
                      aria-label={language.t("server.sync.pairCode.label")}
                    />
                  </div>
                  <div class="settings-v2-servers-actions">
                    <ButtonV2 size="small" variant="ghost-muted" disabled={state.pairing} onClick={pair}>
                      {language.t("server.sync.pair")}
                    </ButtonV2>
                  </div>
                </div>
                <div class="settings-v2-servers-row">
                  <div class="settings-v2-servers-lead">
                    <div class="settings-v2-servers-copy">
                      <span class="settings-v2-servers-name">{language.t("server.sync.prefs.label")}</span>
                    </div>
                  </div>
                  <div class="settings-v2-servers-actions">
                    <SelectV2
                      appearance="inline"
                      data-action="sync-prefs-choice"
                      options={[...PREFS_OPTIONS]}
                      current={PREFS_OPTIONS.find((option) => option.id === state.prefs)}
                      value={(option) => option.id}
                      label={(option) => language.t(option.label)}
                      onSelect={(option) => option && setState("prefs", option.id)}
                      placement="bottom-end"
                      gutter={6}
                    />
                  </div>
                </div>
                <Show when={state.pairFailure}>
                  {(failure) => (
                    <div class="settings-v2-servers-row">
                      <span class="settings-v2-servers-meta">{language.t(PAIR_FAILURE_KEYS[failure()])}</span>
                    </div>
                  )}
                </Show>
              </>
            }
          >
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-name">{lastSync(status())}</span>
                  <span class="settings-v2-servers-meta">
                    {language.t("server.sync.counts", { received: status().received, sent: status().sent })}
                  </span>
                </div>
              </div>
              <div class="settings-v2-servers-actions">
                <ButtonV2 size="small" variant="ghost-muted" disabled={status().paused} onClick={syncNow}>
                  {language.t("server.sync.syncNow")}
                </ButtonV2>
                <ButtonV2 size="small" variant="ghost-muted" onClick={togglePause}>
                  {status().paused ? language.t("server.sync.resume") : language.t("server.sync.pause")}
                </ButtonV2>
                <ButtonV2 size="small" variant="ghost-muted" onClick={unpair}>
                  {language.t("server.sync.unpair")}
                </ButtonV2>
              </div>
            </div>
            <Show when={state.pairNotice}>
              {(notice) => (
                <div class="settings-v2-servers-row">
                  <span class="settings-v2-servers-meta settings-v2-servers-meta--wrap">{language.t(notice())}</span>
                </div>
              )}
            </Show>
            <Show when={status().backlog}>
              {(backlog) => (
                <div class="settings-v2-servers-row">
                  <span class="settings-v2-servers-meta">
                    {language.t("server.sync.progress", { done: backlog().done, total: backlog().total })}
                  </span>
                </div>
              )}
            </Show>
            <Show when={status().missingDirectories.length > 0}>
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-meta">
                    {language.t("server.sync.missing", { count: status().missingDirectories.length })}
                  </span>
                  <For each={status().missingDirectories}>
                    {(directory) => <span class="settings-v2-servers-meta font-mono">{directory}</span>}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={problem(status())}>
              {(text) => (
                <div class="settings-v2-servers-row">
                  <span class="settings-v2-servers-meta settings-v2-servers-meta--wrap">{text()}</span>
                </div>
              )}
            </Show>
          </Show>
        </SettingsListV2>
      )}
    </Show>
  )
}
