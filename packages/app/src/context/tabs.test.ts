import { describe, expect, test } from "bun:test"
import { createRoot, getOwner, onCleanup } from "solid-js"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import type { DraftTab, SessionTab, Tab } from "./tabs"
import { migrateTabs } from "./tab-migration"
import { draftRouteChange, promoteDraft, unusedDraftPrompt } from "./draft-tabs"
import { sessionHref } from "@/utils/session-route"
import type { ServerConnection } from "./server"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

function sessionTab(sessionId: string): SessionTab {
  return { type: "session", server, sessionId }
}

const draft = (draftID: string, directory = "/repo"): DraftTab => ({ type: "draft", draftID, server, directory })

describe("tab migration", () => {
  test("drops null and malformed persisted tabs", () => {
    expect(
      migrateTabs([null, draft("d"), { type: "draft", server }, { type: "unknown", server }, "invalid"], server),
    ).toEqual([draft("d")])
  })

  test("adds the fallback server to valid legacy tabs", () => {
    expect(migrateTabs([{ type: "draft", draftID: "d", directory: "/repo" }], server)).toEqual([draft("d")])
  })

  // Sessions are navigated from the sidebar; tabs persisted before that are purged.
  test("purges persisted session tabs", () => {
    expect(migrateTabs([sessionTab("a"), draft("d"), { type: "session", sessionId: "b" }], server)).toEqual([
      draft("d"),
    ])
  })

  test("replaces invalid top-level persisted data", () => {
    expect(migrateTabs(null, server)).toEqual([])
    expect(migrateTabs({}, server)).toEqual([])
  })
})

describe("tab memory", () => {
  test("keeps state until its tab is removed", () => {
    createRoot((dispose) => {
      const memory = createTabMemory(getOwner())
      let disposed = 0
      const first = memory.ensure("tab", "prompt", () => {
        onCleanup(() => disposed++)
        return { value: "prompt" }
      })

      expect(memory.ensure("tab", "prompt", () => ({ value: "other" }))).toBe(first)
      expect(memory.get<typeof first>("tab", "prompt")).toBe(first)
      expect(memory.get("missing", "prompt")).toBeUndefined()
      expect(memory.ensure("other", "prompt", () => ({ value: "other" }))).not.toBe(first)

      memory.remove("tab")
      expect(disposed).toBe(1)
      expect(memory.ensure("tab", "prompt", () => ({ value: "new" }))).not.toBe(first)
      dispose()
    })
  })
})

describe("closed tab stack", () => {
  test("records session tabs with their index", () => {
    const stack = pushClosedTab([], sessionTab("a"), 2)

    expect(stack).toEqual([{ tab: sessionTab("a"), index: 2 }])
  })

  test("ignores draft tabs", () => {
    const draft: Tab = { type: "draft", draftID: "d1", server, directory: "/tmp" }

    expect(pushClosedTab([], draft, 0)).toEqual([])
  })

  test("caps the stack size", () => {
    const stack = Array.from({ length: 30 }, (_, i) => i).reduce<ClosedTab[]>(
      (acc, i) => pushClosedTab(acc, sessionTab(`s${i}`), i),
      [],
    )

    expect(stack).toHaveLength(25)
    expect(stack[0]?.tab.sessionId).toBe("s5")
    expect(stack.at(-1)?.tab.sessionId).toBe("s29")
  })

  test("pops the most recently closed tab", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [])

    expect(result.entry?.tab.sessionId).toBe("b")
    expect(result.stack).toEqual([{ tab: sessionTab("a"), index: 0 }])
  })

  test("skips entries whose tab is already open", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [sessionTab("b")])

    expect(result.entry?.tab.sessionId).toBe("a")
    expect(result.stack).toEqual([])
  })

  test("returns no entry when everything is open or empty", () => {
    expect(takeClosedTab([], []).entry).toBeUndefined()

    const result = takeClosedTab([{ tab: sessionTab("a"), index: 0 }], [sessionTab("a")])
    expect(result.entry).toBeUndefined()
    expect(result.stack).toEqual([])
  })

  test("purges removed sessions", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]

    expect(removeClosedTabs(stack, server, ["a"])).toEqual([{ tab: sessionTab("b"), index: 1 }])
  })

  test("does not navigate when a background tab closes", () => {
    const tabs = [sessionTab("a"), sessionTab("b"), sessionTab("c")]

    expect(nextTabAfterClose(tabs, 1, false)).toBeUndefined()
    expect(nextTabAfterClose(tabs, 1, true)).toEqual(sessionTab("c"))
    expect(nextTabAfterClose([sessionTab("a")], 0, true)).toBeNull()
  })
})

describe("draft promotion", () => {
  test("drops the draft and routes to its session without adding a session tab", () => {
    const result = promoteDraft([draft("a"), draft("b")], "a", { server, sessionId: "s1" })

    expect(result.tabs).toEqual([draft("b")])
    expect(result.tabs.some((tab) => tab.type === "session")).toBe(false)
    expect(result.href).toBe(sessionHref(server, "s1"))
  })
})

describe("draft route changes", () => {
  const unused = (ids: string[]) => (tab: DraftTab) => ids.includes(tab.draftID)

  test("remembers the last non-Home route for the Home toggle", () => {
    expect(draftRouteChange({ path: "/server/x/session/s1", back: undefined, tabs: [], unused: () => true }).back).toBe(
      "/server/x/session/s1",
    )
    expect(draftRouteChange({ path: "/", back: "/server/x/session/s1", tabs: [], unused: () => true }).back).toBe(
      "/server/x/session/s1",
    )
  })

  test("drops a never-used draft once it is left", () => {
    const tabs = [draft("a"), draft("b")]
    const result = draftRouteChange({
      path: "/server/x/session/s1",
      back: "/new-session?draftId=a",
      tabs,
      unused: unused(["a", "b"]),
    })

    expect(result.prune).toEqual(["a", "b"])
  })

  test("keeps the shown draft, the Home toggle's draft and drafts with a prompt", () => {
    const tabs = [draft("shown"), draft("typed"), draft("back")]
    expect(
      draftRouteChange({
        path: "/new-session?draftId=shown",
        back: undefined,
        tabs,
        unused: unused(["shown", "back"]),
      }).prune,
    ).toEqual(["back"])
    expect(
      draftRouteChange({
        path: "/",
        back: "/new-session?draftId=back",
        tabs,
        unused: unused(["shown", "back"]),
      }).prune,
    ).toEqual(["shown"])
  })
})

describe("unused draft prompts", () => {
  const prompt = (input: { ready?: boolean; dirty?: boolean; items?: number }) => ({
    ready: () => input.ready ?? true,
    dirty: () => input.dirty ?? false,
    context: { items: () => Array.from({ length: input.items ?? 0 }) },
  })

  test("counts a loaded, empty prompt without context as unused", () => {
    expect(unusedDraftPrompt(prompt({}))).toBe(true)
  })

  test("keeps drafts with text, attached context, an unloaded prompt or none in memory", () => {
    expect(unusedDraftPrompt(prompt({ dirty: true }))).toBe(false)
    expect(unusedDraftPrompt(prompt({ items: 1 }))).toBe(false)
    expect(unusedDraftPrompt(prompt({ ready: false }))).toBe(false)
    expect(unusedDraftPrompt(undefined)).toBe(false)
  })
})
