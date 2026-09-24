import { describe, expect, test } from "bun:test"
import { createComponent, createContext, createRoot, onCleanup, useContext } from "solid-js"
import type { Prompt } from "@/context/prompt"
import { createScopedHistoryRouter, createScopedPromptInputHistory } from "./scoped-history"

const text = (value: string): Prompt => [{ type: "text", content: value, start: 0, end: value.length }]

function memoryHistory() {
  const normal: Prompt[] = []
  const shell: Prompt[] = []
  return {
    entries: (mode: "normal" | "shell") => (mode === "shell" ? [...shell] : [...normal]),
    add(prompt: Prompt, mode: "normal" | "shell") {
      ;(mode === "shell" ? shell : normal).unshift(prompt)
    },
  }
}

describe("scoped history router", () => {
  test("session histories are separate and fall back to the shared list without a session", () => {
    let id: string | undefined
    const created: string[] = []
    const history = createScopedHistoryRouter({
      sessionID: () => id,
      global: memoryHistory(),
      create: ({ sessionID }) => {
        created.push(sessionID)
        return memoryHistory()
      },
    })

    history.add(text("draft-before-create"), "normal", [])
    expect(history.entries("normal").length).toBe(1)

    id = "ses_a"
    history.add(text("a-first"), "normal", [])
    history.add(text("a-second"), "normal", [])
    expect(history.entries("normal").length).toBe(2)
    expect(JSON.stringify(history.entries("normal"))).not.toContain("draft-before-create")

    id = "ses_b"
    expect(history.entries("normal").length).toBe(0)
    history.add(text("b-first"), "normal", [])
    expect(history.entries("normal").length).toBe(1)

    id = "ses_a"
    expect(history.entries("normal").length).toBe(2)
    expect(JSON.stringify(history.entries("normal"))).not.toContain("b-first")

    id = undefined
    expect(history.entries("normal").length).toBe(1)
    expect(created).toEqual(["ses_a", "ses_b"])
  })

  test("shell and normal modes stay separate within one session", () => {
    let id: string | undefined = "ses_c"
    const history = createScopedHistoryRouter({
      sessionID: () => id,
      global: memoryHistory(),
      create: () => memoryHistory(),
    })
    history.add(text("c-normal"), "normal", [])
    history.add(text("c-shell"), "shell", [])
    expect(history.entries("normal").length).toBe(1)
    expect(history.entries("shell").length).toBe(1)
    expect(JSON.stringify(history.entries("normal"))).not.toContain("c-shell")
    id = undefined
  })

  test("caches at most max session histories and disposes evicted ones", () => {
    const disposed: string[] = []
    let id: string | undefined
    const history = createScopedHistoryRouter({
      sessionID: () => id,
      global: memoryHistory(),
      create: () => memoryHistory(),
      max: 2,
      dispose: (sessionID) => {
        disposed.push(sessionID)
      },
    })
    for (const sessionID of ["s1", "s2", "s3"]) {
      id = sessionID
      history.add(text("x"), "normal", [])
    }
    expect(disposed).toEqual(["s1"])
  })
})

describe("createScopedPromptInputHistory routing", () => {
  test("routes by session id through the injected factories", () => {
    const created: string[] = []
    let id: string | undefined
    const history = createScopedPromptInputHistory(
      () => id,
      () => "/dir",
      {
        createGlobal: () => memoryHistory(),
        createPersisted: ({ sessionID }) => {
          created.push(sessionID)
          return memoryHistory()
        },
      },
    )

    history.add(text("draft"), "normal", [])
    expect(created).toEqual([])

    id = "ses_x"
    history.add(text("x-one"), "normal", [])
    history.add(text("x-two"), "normal", [])
    expect(created).toEqual(["ses_x"])
    expect(history.entries("normal").length).toBe(2)

    id = "ses_y"
    expect(history.entries("normal").length).toBe(0)

    id = "ses_x"
    expect(history.entries("normal").length).toBe(2)
  })
})

describe("createScopedPromptInputHistory ownership", () => {
  test("session histories created after setup still see the component's context", () => {
    const Scope = createContext<string>()
    const seen: Array<string | undefined> = []
    let id: string | undefined
    let history: ReturnType<typeof createScopedPromptInputHistory> | undefined
    const dispose = createRoot((dispose) => {
      createComponent(Scope.Provider, {
        value: "component",
        get children() {
          history = createScopedPromptInputHistory(
            () => id,
            () => "/dir",
            {
              createGlobal: () => memoryHistory(),
              createPersisted: () => {
                seen.push(useContext(Scope))
                return memoryHistory()
              },
            },
          )
          return undefined
        },
      })
      return dispose
    })

    // Submit records the prompt from an event handler, long after the component was set up.
    id = "ses_ctx"
    history?.add(text("sent"), "normal", [])
    expect(seen).toEqual(["component"])
    dispose()
  })

  test("disposes evicted session histories and the rest when the component is cleaned up", () => {
    const cleaned: string[] = []
    let id: string | undefined
    let history: ReturnType<typeof createScopedPromptInputHistory> | undefined
    const dispose = createRoot((dispose) => {
      history = createScopedPromptInputHistory(
        () => id,
        () => "/dir",
        {
          createGlobal: () => memoryHistory(),
          createPersisted: ({ sessionID }) => {
            onCleanup(() => cleaned.push(sessionID))
            return memoryHistory()
          },
        },
      )
      return dispose
    })

    // Nine sessions overflow the eight cached histories, so the oldest is evicted.
    const sessions = Array.from({ length: 9 }, (_, index) => `s${index + 1}`)
    for (const sessionID of sessions) {
      id = sessionID
      history?.add(text("x"), "normal", [])
    }
    expect(cleaned).toEqual(["s1"])

    dispose()
    expect(cleaned).toEqual(sessions)
  })
})