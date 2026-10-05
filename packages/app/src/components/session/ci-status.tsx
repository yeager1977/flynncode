import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { createEffect, createMemo, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import {
  autoArchiveAfterPrClose,
} from "./ci-status-auto-archive"
import { checkDotClass, FAILED_STATES, GH_DOCS_URL, prLoadError, normalizePrStatus, summaryKey, type Check, type LoadState, type PrStatusPayload } from "./ci-status-helpers"

export function CiStatusStrip() {
  const language = useLanguage()
  const platform = usePlatform()
  const sdk = useSDK()
  const settings = useSettings()
  const sync = useSync()
  const { params } = useSessionLayout()
  const dialog = useDialog()

  const [state, setState] = createStore<LoadState>({ kind: "hidden" })
  const [ui, setUi] = createStore({
    refreshing: false,
    scheduling: false,
    notifiedFor: undefined as string | undefined,
    archivedFor: undefined as string | undefined,
  })

  // No session selected (new-session draft): the strip stays out of the way.
  const visible = createMemo(() => !!params.id && !!sdk().directory)
  const readyData = createMemo<PrStatusPayload | undefined>(() => (state.kind === "ready" ? state.data : undefined))
  const sessionWorking = createMemo(() => (params.id ? sync().data.session_working(params.id) : false))
  const sessionArchived = createMemo(() => {
    const id = params.id
    return id ? sync().session.get(id)?.time.archived !== undefined : false
  })

  const refresh = async () => {
    const directory = sdk().directory
    if (!directory) return
    setUi("refreshing", true)
    try {
      const result = await sdk().client.pullRequest.status({ directory }, { throwOnError: true })
      setState({ kind: "ready", data: normalizePrStatus(result.data) })
    } catch (error) {
      setState(prLoadError(error))
    } finally {
      setUi("refreshing", false)
    }
  }

  onMount(() => {
    void refresh()
  })

  // Re-poll on demand only. There is no durable git.push event to subscribe
  // to; a manual refresh button plus mount-time fetch covers CI latency.
  const onRefresh = () => void refresh()

  const openPr = () => {
    if (state.kind !== "ready") return
    if (state.data.pr.url) platform.openExternal(state.data.pr.url)
  }

  const autoFix = () => {
    if (state.kind !== "ready") return
    const id = params.id
    if (!id) return
    const failed = state.data.checks.filter((check) => FAILED_STATES.has(check.state))
    if (failed.length === 0) return
    const text = [
      language.t("session.ci.action.autoFix"),
      ...failed.map((check) =>
        [
          check.name,
          language.t(`session.ci.check.state.${check.state.toLowerCase()}` as "session.ci.check.state.failure"),
          check.detail,
        ]
          .filter(Boolean)
          .join(": "),
      ),
    ]
      .filter(Boolean)
      .join("\n")
    void sdk()
      .client.session.prompt({
        sessionID: id,
        delivery: "steer",
        parts: [{ type: "text", text }],
      })
      .then(() => {
        showToast({
          variant: "success",
          title: language.t("session.ci.action.autoFix"),
          description: language.t("session.ci.action.autoFix.sent"),
        })
      })
      .catch(() => {
        showToast({
          variant: "error",
          title: language.t("session.ci.action.autoFix"),
          description: language.t("session.ci.action.autoFix.failed"),
        })
      })
  }

  const scheduleAutoMerge = () => {
    if (state.kind !== "ready") return
    dialog.show(() => (
      <Dialog
        title={language.t("session.ci.action.autoMerge")}
        description={language.t("session.ci.action.autoMerge.confirm")}
        fit
      >
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                void runAutoMerge()
              }}
            >
              {language.t("session.ci.action.autoMerge")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const runAutoMerge = async () => {
    const directory = sdk().directory
    if (!directory) return
    setUi("scheduling", true)
    try {
      await sdk().client.pullRequest.merge({ directory }, { throwOnError: true })
      showToast({
        variant: "success",
        title: language.t("session.ci.action.autoMerge"),
        description: language.t("session.ci.action.autoMerge.scheduled"),
      })
    } catch (error) {
      // Auto-merge can be rejected by the repository's own GitHub setting;
      // surface gh's raw message so the user knows what to flip.
      showToast({
        variant: "error",
        title: language.t("session.ci.action.autoMerge"),
        description: error instanceof Error ? error.message : language.t("session.ci.action.autoMerge.failed"),
      })
    } finally {
      setUi("scheduling", false)
      await refresh()
    }
  }

  // Notify once per checks-transition when the window is unfocused.
  createEffect(() => {
    if (state.kind !== "ready") return
    const checks = state.data.checks
    const failing = checks.filter((check) => FAILED_STATES.has(check.state))
    const done = failing.length > 0 || !checks.some((check) => check.state === "PENDING")
    const transitionKey = `${state.data.pr.number}:${failing.length > 0 ? "failed" : done ? "passed" : "running"}`
    if (!done) return
    if (document.hasFocus()) return
    if (ui.notifiedFor === transitionKey) return
    setUi("notifiedFor", transitionKey)
    const key = failing.length > 0 ? "session.ci.notifications.failed" : "session.ci.notifications.passed"
    void platform.notify(
      language.t(key),
      language.t("session.ci.notifications.description", {
        number: state.data.pr.number,
        checks:
          failing.length > 0 ? failing.map((check) => check.name).join(", ") : language.t("session.ci.checks.passing"),
      }),
      openPr,
    )
  })

  // Auto-archive observation: fire once per (session, merged|closed state)
  // when the setting is on and no work is running. App-side decision, default
  // off; archives through the same session.update path the bulk cleanup uses.
  createEffect(() => {
    if (state.kind !== "ready") return
    const id = params.id
    const directory = sdk().directory
    if (!id || !directory) return
    const decision = autoArchiveAfterPrClose({
      prState: state.data.pr.state,
      sessionRunning: sessionWorking(),
      sessionArchived: sessionArchived(),
      settingEnabled: settings.cleanup.autoArchiveAfterPrClose(),
    })
    if (decision !== "archive") return
    if (ui.archivedFor === id) return
    setUi("archivedFor", id)
    void sdk()
      .client.session.update({ sessionID: id, directory, time: { archived: Date.now() } })
      .then(() => {
        showToast({
          variant: "success",
          title: language.t("session.ci.toast.archived"),
        })
      })
      .catch(() => setUi("archivedFor", undefined))
  })

  return (
    <Show when={visible()}>
      <div data-component="ci-status-strip" class="shrink-0 flex items-center min-h-0">
        <Show when={state.kind !== "hidden"}>
          <div
            class="flex items-center gap-2 h-[24px] box-border rounded-md border border-border-weak-base bg-surface-panel overflow-hidden max-w-full"
            data-state={state.kind}
          >
            <Show when={state.kind === "loading"}>
              <span class="flex items-center gap-1.5 px-2 py-0 text-12-regular text-text-weak">
                <Spinner class="size-3" />
                {language.t("session.ci.status.loading")}
              </span>
            </Show>
            <Show when={state.kind === "error"}>
              <Show
                when={state.kind === "error" && state.name === "GhMissingError"}
                fallback={
                  <span
                    class="flex items-center gap-1.5 px-2 py-0 text-12-regular text-text-weak"
                    title={state.kind === "error" ? state.message : undefined}
                  >
                    <Icon name="circle-ban-sign" size="small" class="text-icon-weak" />
                    {language.t("session.ci.error.details")}
                  </span>
                }
              >
                <a
                  href={GH_DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  class="flex items-center gap-1.5 px-2 py-0 text-12-regular text-text-weak hover:text-text-strong"
                  onClick={(event) => {
                    event.preventDefault()
                    platform.openExternal(GH_DOCS_URL)
                  }}
                >
                  <Icon name="circle-ban-sign" size="small" class="text-icon-weak" />
                  {language.t("session.ci.status.noGh")}
                </a>
              </Show>
            </Show>
            <Show when={readyData()} keyed>
              {(data) => {
                const failing = data.checks.filter((check) => FAILED_STATES.has(check.state))
                return (
                  <>
                    <button
                      type="button"
                      class="flex items-center gap-1.5 px-2 py-0 h-full text-12-regular text-text-strong"
                      data-action="ci-status-pr"
                      onClick={openPr}
                      aria-label={language.t("session.ci.pr.link.title")}
                    >
                      <Icon name="branch" size="small" class="text-icon-base" />
                      {language.t("session.ci.status.pr", { number: data.pr.number })}
                      <span data-slot="ci-pr-state" class="text-12-regular text-text-weak">
                        {language.t(
                          `session.ci.pr.state.${data.pr.state.toLowerCase()}` as "session.ci.pr.state.open",
                        )}
                      </span>
                    </button>
                    <span
                      data-slot="ci-check-summary"
                      class="flex items-center gap-1.5 px-2 py-0 text-12-regular text-text-weak"
                      title={data.checks.map((check) => check.name).join(", ")}
                    >
                      <For each={data.checks.slice(0, 5)}>
                        {(check) => (
                          <span
                            data-slot="ci-check-dot"
                            data-state={check.state}
                            class={`size-1.5 rounded-full ${checkDotClass(check.state)}`}
                            title={`${check.name} — ${language.t(
                              `session.ci.check.state.${check.state.toLowerCase()}` as "session.ci.check.state.success",
                            )}`}
                          />
                        )}
                      </For>
                      {language.t(summaryKey(data.checks), { count: failing.length })}
                    </span>
                    <Show when={failing.length > 0}>
                      <Button variant="ghost" size="small" data-action="ci-status-autofix" onClick={autoFix}>
                        {language.t("session.ci.action.autoFix")}
                      </Button>
                    </Show>
                    <Button
                      variant="ghost"
                      size="small"
                      disabled={ui.scheduling || data.pr.state !== "OPEN"}
                      data-action="ci-status-automerge"
                      onClick={scheduleAutoMerge}
                    >
                      {language.t("session.ci.action.autoMerge")}
                    </Button>
                  </>
                )
              }}
            </Show>
            <Button
              variant="ghost"
              size="small"
              disabled={ui.refreshing}
              data-action="ci-status-refresh"
              aria-label={language.t("session.ci.action.refresh")}
              onClick={onRefresh}
            >
              <Show when={ui.refreshing} fallback={<Icon name="arrow-undo-down" size="small" />}>
                <Spinner class="size-3" />
              </Show>
            </Button>
          </div>
        </Show>
      </div>
    </Show>
  )
}