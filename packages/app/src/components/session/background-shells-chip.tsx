import { Show, createMemo } from "solid-js"
import { Button } from "@flynncode/ui/button"
import { Tooltip } from "@flynncode/ui/tooltip"
import { useLanguage } from "@/context/language"
import { runningCount, useBackgroundShells } from "@/hooks/use-background-shells"

export function BackgroundShellsChip(props: { sessionID: string | undefined; onOpen: () => void }) {
  const language = useLanguage()
  const store = useBackgroundShells(() => props.sessionID)
  const running = createMemo(() => runningCount(store.shells()))

  return (
    <Show when={running() > 0}>
      <Tooltip placement="bottom" value={language.t("session.shells.chip.tooltip")}>
        <Button
          type="button"
          variant="ghost"
          size="small"
          class="shrink-0"
          data-action="session-shells-chip"
          aria-controls="tasks-panel"
          aria-label={language.t("session.shells.chip.label", { count: running() })}
          onClick={props.onOpen}
        >
          <span aria-hidden="true">⚙</span> {language.t("session.shells.chip", { count: running() })}
        </Button>
      </Tooltip>
    </Show>
  )
}
