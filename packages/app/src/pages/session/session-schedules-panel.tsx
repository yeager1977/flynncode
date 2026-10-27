import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Button } from "@flynncode/ui/button"
import { useLanguage } from "@/context/language"
import { formatElapsed } from "@/hooks/use-background-shells"
import { scheduleRows, useSessionSchedules, type ScheduleRow } from "@/hooks/use-session-schedules"
import { showToast } from "@/utils/toast"

export function SessionSchedulesSection(props: { sessionID: () => string }) {
  const language = useLanguage()
  const store = useSessionSchedules(() => props.sessionID() || undefined)
  const [now, setNow] = createSignal(Date.now())
  const rows = createMemo(() => scheduleRows(store.jobs(), now()))
  // Rows are keyed by id and read through the map, so the countdown tick never remounts a row and drops its in-flight state.
  const ids = createMemo(() => rows().map((row) => row.id))
  const byID = createMemo(() => new Map(rows().map((row) => [row.id, row])))

  createEffect(() => {
    if (ids().length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={ids().length > 0}>
      <div class="flex flex-col gap-2 p-2 pb-0 text-12-regular text-text-base" data-component="session-schedules">
        <div class="text-text-weak">
          <span aria-hidden="true">⏰</span> {language.t("session.schedules.title")} {ids().length}
        </div>
        <For each={ids()}>{(id) => <Row row={() => byID().get(id)} cancel={() => store.cancel(id)} />}</For>
      </div>
    </Show>
  )
}

function Row(props: { row: () => ScheduleRow | undefined; cancel: () => Promise<boolean> }) {
  return <Show when={props.row()}>{(row) => <RowBody row={row} cancel={props.cancel} />}</Show>
}

function RowBody(props: { row: () => ScheduleRow; cancel: () => Promise<boolean> }) {
  const language = useLanguage()
  const [cancelling, setCancelling] = createSignal(false)

  const heading = () =>
    language.t(props.row().kind === "cron" ? "session.schedules.kind.cron" : "session.schedules.kind.wakeup")
  const nextRun = () =>
    props.row().due
      ? language.t("session.schedules.nextRun.due")
      : language.t("session.schedules.nextRun", { time: formatElapsed(props.row().remainingMs) })

  const cancel = async () => {
    if (cancelling()) return
    setCancelling(true)
    const ok = await props.cancel()
    setCancelling(false)
    if (!ok) showToast({ title: language.t("session.schedules.cancel.failed") })
  }

  return (
    <div
      class="flex flex-col gap-1 rounded-md border border-border-weak-base bg-v2-background-bg-layer-02 px-2 py-1.5"
      data-action="session-schedule-row"
      data-kind={props.row().kind}
    >
      <div class="truncate text-text-strong" title={props.row().detail}>
        {heading()}
        <Show when={props.row().detail}>
          {" · "}
          <bdi dir="ltr" class={props.row().kind === "cron" ? "font-mono" : undefined}>
            {props.row().detail}
          </bdi>
        </Show>
      </div>
      <div class="line-clamp-2 break-words" title={props.row().prompt}>
        {props.row().prompt}
      </div>
      <div class="text-text-weak">
        {nextRun()}
        {" · "}
        {language.t(props.row().recurring ? "session.schedules.repeats" : "session.schedules.once")}
      </div>
      <div class="flex flex-wrap gap-1">
        <Button
          type="button"
          size="small"
          variant="ghost"
          data-action="session-schedule-cancel"
          disabled={cancelling()}
          onClick={() => void cancel()}
        >
          {cancelling() ? language.t("session.schedules.cancelling") : language.t("session.schedules.cancel")}
        </Button>
      </div>
    </div>
  )
}
