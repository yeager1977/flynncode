import { Show } from "solid-js"
import { Button } from "@flynncode/ui/button"
import { DockPrompt } from "@flynncode/session-ui/dock-prompt"
import { Icon } from "@flynncode/ui/icon"
import { useLanguage } from "@/context/language"

export function SessionWaitingTerminalDock(props: {
  command?: string
  onOpen: () => void
}) {
  const language = useLanguage()

  return (
    <div data-component="session-waiting-terminal-dock">
      <DockPrompt
        kind="terminal"
        header={
          <div data-slot="terminal-row" data-variant="header">
            <span data-slot="terminal-icon">
              <Icon name="terminal" size="normal" />
            </span>
            <div data-slot="terminal-header-title">{language.t("session.waitingTerminal.title")}</div>
          </div>
        }
        footer={
          <>
            <div />
            <div data-slot="terminal-footer-actions">
              <Button variant="primary" size="normal" onClick={props.onOpen}>
                {language.t("session.waitingTerminal.open")}
              </Button>
            </div>
          </>
        }
      >
        <div data-slot="terminal-row">
          <span data-slot="terminal-spacer" aria-hidden="true" />
          <div data-slot="terminal-hint">{language.t("session.waitingTerminal.hint")}</div>
        </div>
        <Show when={props.command}>
          <div data-slot="terminal-row">
            <span data-slot="terminal-spacer" aria-hidden="true" />
            <code data-slot="terminal-command" dir="ltr">
              {props.command}
            </code>
          </div>
        </Show>
      </DockPrompt>
    </div>
  )
}
