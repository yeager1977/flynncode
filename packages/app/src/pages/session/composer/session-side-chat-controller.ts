import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { sideChatStore } from "./session-side-chat-store"

// A side chat is a real forked session on the server, but the conversation is
// treated as transient client-side: turns are only appended to this in-memory
// store and the forked record is removed on close. Nothing touches the
// persisted prompt/composer or the main timeline transcript.
export function createSideChatController() {
  const sdk = useSDK()
  const { params, sessionKey } = useSessionLayout()
  const language = useLanguage()

  const state = () => sideChatStore.get(sessionKey())
  const isOpen = () => state()?.open === true
  const starting = () => state()?.starting === true
  const sending = () => state()?.sending === true
  const sideID = () => state()?.sideID
  const turns = () => state()?.turns ?? []

  const open = () => {
    const key = sessionKey()
    const id = params.id
    if (!key || !id || starting() || isOpen()) return
    const client = sdk()
    sideChatStore.start(key)
    // The store record is keyed by the captured session, so it is updated even
    // if the user switched tabs meanwhile; only UI feedback follows the tab.
    client.api.session
      .fork({ sessionID: id })
      .then((forked) => {
        if (sideChatStore.get(key)?.open) {
          sideChatStore.ready(key, forked.id)
          return
        }
        void client.api.session.remove({ sessionID: forked.id }).catch(() => {})
      })
      .catch(() => {
        sideChatStore.close(key)
        if (sessionKey() !== key) return
        showToast({ title: language.t("session.sidechat.startFailed") })
      })
  }

  const close = () => {
    const key = sessionKey()
    if (!key) return
    const id = sideID()
    void (id ? sdk().api.session.remove({ sessionID: id }).catch(() => {}) : Promise.resolve())
    sideChatStore.close(key)
  }

  const send = (text: string) => {
    const key = sessionKey()
    const id = sideID()
    if (!key || !id || sending()) return
    sideChatStore.appendTurn(key, "user", text)
    sideChatStore.setSending(key, true)
    // Fire-and-forget on purpose: the answer may take a long time and the
    // dock shows no streaming transcript. On failure the user turn stays so
    // the user can retry; reload discards everything by design.
    void sdk()
      .api.session.generate({ sessionID: id, prompt: text })
      .then((answer) => {
        sideChatStore.setSending(key, false)
        if (!answer.text.trim()) return
        sideChatStore.appendTurn(key, "assistant", answer.text)
      })
      .catch(() => {
        sideChatStore.setSending(key, false)
        if (sessionKey() !== key) return
        showToast({ title: language.t("session.sidechat.sendFailed") })
      })
  }

  return { key: sessionKey, state, open, isOpen, starting, sending, sideID, turns, close, send }
}