import { For, Show } from "solid-js"
import { parseAnsi } from "@flynncode/ui/theme/ansi"
import { useLanguage } from "@/context/language"
import { statusLineVisible, useSessionStatusLine } from "@/hooks/use-session-statusline"
import { ansiCssColor } from "./session-status-line-color"
import "./session-status-line.css"

export function SessionStatusLine(props: { sessionID: string | undefined }) {
  const language = useLanguage()
  const lines = useSessionStatusLine(() => props.sessionID)

  return (
    <Show when={statusLineVisible(lines())}>
      <div
        data-component="session-status-line"
        role="status"
        aria-label={language.t("session.statusline.label")}
        class="px-3 pt-1"
      >
        <For each={lines()}>
          {(line) => (
            <div data-slot="status-line-row">
              <For each={parseAnsi(line)}>
                {(run) => (
                  <span
                    data-bold={run.bold ? "" : undefined}
                    data-dim={run.dim ? "" : undefined}
                    style={{
                      color: run.fg === undefined ? undefined : ansiCssColor(run.fg),
                      "background-color": run.bg === undefined ? undefined : ansiCssColor(run.bg),
                    }}
                  >
                    {run.text}
                  </span>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
