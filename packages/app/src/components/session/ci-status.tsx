import { Button } from "@flynncode/ui/button"
import { DropdownMenu } from "@flynncode/ui/dropdown-menu"
import { Tooltip } from "@flynncode/ui/tooltip"
import { createEffect, createMemo, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useDialog } from "@flynncode/ui/context/dialog"
import { Dialog } from "@flynncode/ui/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"
import { useTitlebarRightMount } from "../titlebar"
import {
  checkDotClass,
  FAILED_STATES,
  prLoadError,
  normalizePrStatus,
  summaryKey,
  type LoadState,
  type PrStatusPayload,
} from "./ci-status-helpers"

// Compact PR/CI indicator in the titlebar actions. It renders only when the
// session's branch has a pull request; everything else stays behind its menu.
//
// Auto-archive after PR close is intentionally not wired here: the PR status
// belongs to the directory's branch, and nothing binds a session to that PR,
// so archiving whichever session is open could archive the wrong one.
export function CiStatusStrip() {
  const language = useLanguage()
  const platform = usePlatform()
  const sdk = useSDK()
  const { params } = useSessionLayout()
  const dialog = useDialog()
  const rightMount = useTitlebarRightMount()

  const [state, setState] = createStore<LoadState>({ kind: "hidden" })
  const [ui, setUi] = createStore({
    refreshing: false,
    scheduling: false,
    notifiedFor: undefined as string | undefined,
  })

  const readyData = createMemo<PrStatusPayload | undefined>(() => (state.kind === "ready" ? state.data : undefined))

  const refresh = async () => {
    const directory = sdk().directory
    if (!directory) return
    setUi("refreshing", true)
    try {
      const result = await sdk().client.pullRequest.status({ directory }, { throwOnError: true })
      setState({ kind: "ready", data: normalizePrStatus(result.data) })
    } catch (error) {
      // No PR is a normal hidden state; anything else (gh missing, auth,
      // network) is logged instead of putting an error chip on every session.
      const failure = prLoadError(error)
      if (failure.kind === "error") console.warn("[ci-status] pull request status unavailable", failure)
      setState({ kind: "hidden" })
    } finally {
      setUi("refreshing", false)
    }
  }

  onMount(() => {
    void refresh()
  })

  // Re-poll on demand only. There is no durable git.push event to subscribe
  // to; a manual refresh item plus mount-time fetch covers CI latency.
  const onRefresh = () => void refresh()

  const openPr = () => {
    if (state.kind !== "ready") return
    if (state.data.pr.url) platform.openExternal(state.data.pr.url)
  }

  const checkStateLabel = (check: { state: string }) =>
    language.t(`session.ci.check.state.${check.state.toLowerCase()}` as "session.ci.check.state.success")

  const autoFix = () => {
    if (state.kind !== "ready") return
    const id = params.id
    if (!id) return
    const failed = state.data.checks.filter((check) => FAILED_STATES.has(check.state))
    if (failed.length === 0) return
    const text = [
      language.t("session.ci.action.autoFix"),
      ...failed.map((check) => [check.name, checkStateLabel(check), check.detail].filter(Boolean).join(": ")),
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

  return (
    <Show when={params.id ? rightMount() : undefined} keyed>
      {(mount) => (
        <Portal mount={mount}>
          <Show when={readyData()} keyed>
            {(data) => {
              const failing = data.checks.filter((check) => FAILED_STATES.has(check.state))
              const summary = () => language.t(summaryKey(data.checks), { count: failing.length })
              // The trigger dot shows the worst check state, matching the summary.
              const worst = () => {
                if (failing.length > 0) return "FAILURE"
                if (data.checks.some((check) => check.state === "PENDING")) return "PENDING"
                if (data.checks.length > 0) return "SUCCESS"
                return "SKIPPED"
              }
              return (
                <div data-component="ci-status-indicator" class="shrink-0 flex items-center">
                  <DropdownMenu gutter={4} placement="bottom-end">
                    <Tooltip placement="bottom" value={summary()}>
                      <DropdownMenu.Trigger
                        as={Button}
                        variant="ghost"
                        size="small"
                        class="h-6 gap-1.5 px-1.5"
                        data-action="ci-status-pr"
                        aria-label={language.t("session.ci.status.pr", { number: data.pr.number })}
                      >
                        <span aria-hidden="true" class={`size-2 rounded-full ${checkDotClass(worst())}`} />
                        <span class="text-12-regular text-text-strong">
                          {language.t("session.ci.status.pr", { number: data.pr.number })}
                        </span>
                      </DropdownMenu.Trigger>
                    </Tooltip>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content>
                        <DropdownMenu.Group>
                          <DropdownMenu.GroupLabel>
                            {language.t("session.ci.status.pr", { number: data.pr.number })} ·{" "}
                            {language.t(
                              `session.ci.pr.state.${data.pr.state.toLowerCase()}` as "session.ci.pr.state.open",
                            )}
                          </DropdownMenu.GroupLabel>
                          <div data-slot="ci-check-summary" class="flex flex-col gap-1 px-2 pb-1.5">
                            <For
                              each={data.checks}
                              fallback={
                                <span class="text-12-regular text-text-weak">
                                  {language.t("session.ci.checks.empty")}
                                </span>
                              }
                            >
                              {(check) => (
                                <span class="flex min-w-0 items-center gap-1.5 text-12-regular">
                                  <span
                                    data-slot="ci-check-dot"
                                    data-state={check.state}
                                    class={`size-1.5 shrink-0 rounded-full ${checkDotClass(check.state)}`}
                                  />
                                  <span class="min-w-0 truncate text-text-strong">{check.name}</span>
                                  <span class="shrink-0 text-text-weak">{checkStateLabel(check)}</span>
                                </span>
                              )}
                            </For>
                          </div>
                        </DropdownMenu.Group>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item onSelect={openPr}>
                          <DropdownMenu.ItemLabel>{language.t("session.ci.action.viewPr")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <Show when={failing.length > 0}>
                          <DropdownMenu.Item data-action="ci-status-autofix" onSelect={autoFix}>
                            <DropdownMenu.ItemLabel>{language.t("session.ci.action.autoFix")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <DropdownMenu.Item
                          data-action="ci-status-automerge"
                          disabled={ui.scheduling || data.pr.state !== "OPEN"}
                          onSelect={scheduleAutoMerge}
                        >
                          <DropdownMenu.ItemLabel>{language.t("session.ci.action.autoMerge")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="ci-status-refresh"
                          disabled={ui.refreshing}
                          closeOnSelect={false}
                          onSelect={onRefresh}
                        >
                          <DropdownMenu.ItemLabel>{language.t("session.ci.action.refresh")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              )
            }}
          </Show>
        </Portal>
      )}
    </Show>
  )
}
