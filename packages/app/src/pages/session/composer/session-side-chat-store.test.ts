import { describe, expect, test } from "bun:test"
import { sideChatStore } from "./session-side-chat-store"

describe("side chat store lifecycle", () => {
  test("start opens a transient record that holds no persistence", async () => {
    sideChatStore.clearForTests()

    sideChatStore.start("k1")
    expect(sideChatStore.get("k1")).toEqual({
      open: true,
      starting: true,
      sending: false,
      turns: [],
    })

    sideChatStore.ready("k1", "ses_fork")
    expect(sideChatStore.get("k1")?.starting).toBe(false)
    expect(sideChatStore.get("k1")?.sideID).toBe("ses_fork")
  })

  test("appended turns are keyed by session and survive until close", () => {
    sideChatStore.clearForTests()

    sideChatStore.start("k1")
    sideChatStore.ready("k1", "ses_fork")
    sideChatStore.appendTurn("k1", "user", "what does rows.ts do?")
    sideChatStore.setSending("k1", true)
    sideChatStore.appendTurn("k1", "assistant", "it builds timeline rows")
    sideChatStore.setSending("k1", false)

    expect(sideChatStore.get("k1")?.turns).toEqual([
      { id: "side-turn-1", role: "user", text: "what does rows.ts do?" },
      { id: "side-turn-2", role: "assistant", text: "it builds timeline rows" },
    ])

    // Close removes the whole record: reloading or reopening starts empty.
    sideChatStore.close("k1")
    expect(sideChatStore.get("k1")).toBeUndefined()
  })

  test("ignores appends and sends to a closed or unknown session", () => {
    sideChatStore.clearForTests()

    sideChatStore.appendTurn("ghost", "user", "lost")
    sideChatStore.setSending("ghost", true)
    expect(sideChatStore.get("ghost")).toBeUndefined()
  })

  test("a record left without close is dropped when the store is cleared (reload)", () => {
    sideChatStore.clearForTests()

    sideChatStore.start("k2")
    sideChatStore.ready("k2", "ses_fork2")
    sideChatStore.appendTurn("k2", "user", "transient")
    expect(sideChatStore.get("k2")?.turns.length).toBe(1)

    // Module-level store is memory-only: clearing simulates a page reload,
    // after which nothing about the side chat survives.
    sideChatStore.clearForTests()
    expect(sideChatStore.get("k2")).toBeUndefined()
  })
})