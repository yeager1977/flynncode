import { createStore } from "solid-js/store"
import type { useSideChat } from "./session-side-chat-context"

// Local UI state for the side-chat dock: the in-flight draft and derived
// sendability. The transcripts themselves live in the side-chat store.
export function useSideChatDockState(sideChat: ReturnType<typeof useSideChat>) {
  const [ui, setUi] = createStore({ draft: "" })

  const ready = () => sideChat.isOpen()
  const starting = () => sideChat.starting()
  const sending = () => sideChat.sending()
  const turns = () => sideChat.turns()
  const canSend = () => !sending() && ui.draft.trim().length > 0 && !starting()

  return {
    ready,
    starting,
    sending,
    turns,
    canSend,
    draft: () => ui.draft,
    onDraftChange: (value: string) => setUi("draft", value),
    onSend: () => {
      if (!canSend()) return
      sideChat.send(ui.draft.trim())
      setUi("draft", "")
    },
    onClose: () => {
      setUi("draft", "")
      sideChat.close()
    },
  }
}