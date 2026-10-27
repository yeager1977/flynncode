import { Show, createMemo } from "solid-js"
import { Button } from "@flynncode/ui/button"
import { Tooltip } from "@flynncode/ui/tooltip"
import { useLanguage } from "@/context/language"
import { scheduleChipCount, useSessionSchedules } from "@/hooks/use-session-schedules"

export function SessionSchedulesChip(props: { sessionID: string | undefined; onOpen: () => void }) {
  const language = useLanguage()
  const store = useSessionSchedules(() => props.sessionID)
  const count = createMemo(() => scheduleChipCount(store.jobs()))

  return (
    <Show when={count() > 0}>
      <Tooltip placement="bottom" value={language.t("session.schedules.chip.tooltip")}>
        <Button
          type="button"
          variant="ghost"
          size="small"
          class="shrink-0"
          data-action="session-schedules-chip"
          aria-controls="tasks-panel"
          aria-label={language.t("session.schedules.chip.label", { count: count() })}
          onClick={props.onOpen}
        >
          <span aria-hidden="true">⏰</span> {language.t("session.schedules.chip", { count: count() })}
        </Button>
      </Tooltip>
    </Show>
  )
}
