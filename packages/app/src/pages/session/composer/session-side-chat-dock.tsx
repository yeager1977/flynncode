import { For, Show, type Component } from "solid-js"
import { IconButton } from "@flynncode/ui/icon-button"
import { Button } from "@flynncode/ui/button"
import { TextareaV2 } from "@flynncode/ui/v2/textarea-v2"
import type { SideTurn } from "./session-side-chat-store"

// Composer-region dock for side chats (`/btw`). The open/close lifecycle and
// transports live in the side-chat controller; this component renders the
// in-memory transcript and the input. All copy arrives via i18n-resolved props.
export const SessionSideChatDock: Component<{
  closeLabel: string
  label: string
  hint: string
  inputPlaceholder: string
  sendLabel: string
  starting: boolean
  sending: boolean
  canSend: boolean
  draft: string
  turns: SideTurn[]
  onDraftChange: (value: string) => void
  onSend: () => void
  onClose: () => void
}> = (props) => {
  return (
    <div
      data-component="session-side-chat-dock"
      data-state={props.starting ? "starting" : "open"}
      classList={{
        "rounded-[12px] border px-3 py-2": true,
        "border-v2-border-border-focus": true,
        "bg-v2-background-bg-base": true,
        "opacity-60": props.starting,
      }}
    >
      <div class="flex items-center justify-between gap-2 pb-2">
        <span class="min-w-0 flex-1 truncate" data-slot="session-side-chat-label">
          {props.label}
        </span>
        <IconButton
          icon="close-small"
          size="normal"
          variant="ghost"
          data-action="session-side-chat-close"
          disabled={props.starting}
          aria-label={props.closeLabel}
          onClick={props.onClose}
        />
      </div>

      <div class="max-h-40 overflow-y-auto no-scrollbar" data-slot="session-side-chat-turns">
        <For each={props.turns}>
          {(turn) => (
            <div
              data-slot="session-side-chat-turn"
              data-role={turn.role}
              classList={{
                "whitespace-pre-wrap break-words text-13-regular min-w-0 py-1": true,
                "text-text-strong": turn.role === "assistant",
                "text-text-weak": turn.role === "user",
              }}
            >
              {turn.text}
            </div>
          )}
        </For>
      </div>

      <Show when={!props.starting} fallback={<div class="py-3 text-13-regular text-text-weak">{props.hint}</div>}>
        <div class="pt-2 flex items-end gap-2">
          <TextareaV2
            class="min-h-9 flex-1"
            rows={1}
            placeholder={props.inputPlaceholder}
            value={props.draft}
            onInput={(event) => props.onDraftChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return
              event.preventDefault()
              props.onSend()
            }}
          />
          <Button
            variant="secondary"
            size="small"
            disabled={!props.canSend}
            aria-keyshortcuts="Enter"
            onClick={() => props.onSend()}
          >
            <span data-slot="session-side-chat-send">{props.sendLabel}</span>
          </Button>
        </div>
      </Show>
    </div>
  )
}