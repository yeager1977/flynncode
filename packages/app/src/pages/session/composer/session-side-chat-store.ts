import { createStore, produce } from "solid-js/store"

export type SideTurn = { id: string; role: "user" | "assistant"; text: string }

// A side chat exists only in this module-level store. It is never written to
// Persist/localStorage, so unmounting, closing, or reloading the app clears
// the transcript and the transient forked session record.
export type SideChatRecord = {
  open: boolean
  starting: boolean
  sending: boolean
  sideID?: string
  turns: SideTurn[]
}

const [chats, setChats] = createStore<Record<string, SideChatRecord>>({})

let turnCounter = 0

export const sideChatStore = {
  get(sessionKey: string) {
    return chats[sessionKey]
  },
  // Marks a side chat as opening. A later `ready` attaches the transient
  // session id; a failure calls `close` to fully undo the record.
  start(sessionKey: string) {
    setChats(sessionKey, {
      open: true,
      starting: true,
      sending: false,
      turns: [],
    })
  },
  ready(sessionKey: string, sideID: string) {
    const current = chats[sessionKey]
    if (!current?.open) return
    setChats(sessionKey, { starting: false, sideID })
  },
  setSending(sessionKey: string, sending: boolean) {
    const current = chats[sessionKey]
    if (!current?.open) return
    setChats(sessionKey, "sending", sending)
  },
  appendTurn(sessionKey: string, role: SideTurn["role"], text: string) {
    const current = chats[sessionKey]
    if (!current?.open || !text.trim()) return
    turnCounter += 1
    setChats(
      sessionKey,
      "turns",
      produce((draft) => {
        draft.push({ id: `side-turn-${turnCounter}`, role, text })
      }),
    )
  },
  // Closing removes the whole record: the transcript is gone (and the caller
  // removes the transient forked session from the server).
  close(sessionKey: string) {
    setChats(
      produce((draft) => {
        delete draft[sessionKey]
      }),
    )
  },
  clearForTests() {
    setChats(
      produce((draft) => {
        for (const key of Object.keys(draft)) delete draft[key]
      }),
    )
    turnCounter = 0
  },
}