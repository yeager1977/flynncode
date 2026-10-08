import { createStore } from "solid-js/store"
import type { useSideChat } from "./session-side-chat-context"

// Local UI state for the side-chat dock: the in-flight draft per session and
// derived sendability. The transcripts themselves live in the side-chat store.
export function useSideChatDockState(sideChat: ReturnType<typeof useSideChat>) {
  const [drafts, setDrafts] = createStore<Record<string, string>>({})
  const draft = () => drafts[sideChat.key()] ?? ""
  const setDraft = (value: string) => setDrafts(sideChat.key(), value)

  const ready = () => sideChat.isOpen()
  const starting = () => sideChat.starting()
  const sending = () => sideChat.sending()
  const turns = () => sideChat.turns()
  const canSend = () => !sending() && draft().trim().length > 0 && !starting()

  return {
    ready,
    starting,
    sending,
    turns,
    canSend,
    draft,
    onDraftChange: setDraft,
    onSend: () => {
      if (!canSend()) return
      sideChat.send(draft().trim())
      setDraft("")
    },
    onClose: () => {
      setDraft("")
      sideChat.close()
    },
  }
}
