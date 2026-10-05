import { describe, expect, test } from "bun:test"
import { carryHandoffContext, checkoutHandoff, firstPromptText } from "./checkout-handoff"

describe("checkoutHandoff", () => {
  test("stays on the primary checkout when the directory is not git", () => {
    expect(
      checkoutHandoff({
        current: "/repo",
        primary: "/repo",
        worktrees: [],
        git: false,
      }),
    ).toEqual({ ok: false, reason: "not-git" })
  })

  test("fails closed when the branch is already checked out elsewhere", () => {
    expect(
      checkoutHandoff({
        current: "/repo-wt",
        primary: "/repo",
        branch: "feature",
        worktrees: [
          { directory: "/repo-wt", branch: "feature" },
          { directory: "/other", branch: "feature" },
        ],
        git: true,
      }),
    ).toEqual({ ok: false, reason: "occupied" })
  })

  test("fails closed when the session branch is checked out in another worktree", () => {
    // The header call site only knows the session directory's branch; a
    // different worktree holding that branch must still block the handoff.
    expect(
      checkoutHandoff({
        current: "/repo-wt",
        primary: "/repo",
        branch: "feature",
        worktrees: [{ directory: "/other", branch: "feature" }, { directory: "/repo-wt" }],
        git: true,
      }),
    ).toEqual({ ok: false, reason: "occupied" })
  })

  test("moves back to the primary checkout from a session worktree", () => {
    expect(
      checkoutHandoff({
        current: "/repo-wt",
        primary: "/repo",
        worktrees: [{ directory: "/repo-wt", branch: "feature" }],
        git: true,
      }),
    ).toEqual({ ok: true, directory: "/repo", create: false })
  })
})

describe("carryHandoffContext", () => {
  const recordings = () => ({
    handoff: [] as { from: string; to: string }[],
    created: [] as { directory: string }[],
    archived: [] as { sessionID: string; directory: string }[],
    clients: undefined as never,
  })

  function makeClients(logs: ReturnType<typeof recordings>) {
    const clients = {
      handoffEndpoint: async (input: { from: string; to: string }) => {
        logs.handoff.push(input)
        return true
      },
      createSession: async (input: { directory: string }) => {
        logs.created.push(input)
        return { id: `ses_${logs.created.length}` }
      },
      archiveSession: async (input: { sessionID: string; directory: string }) => {
        logs.archived.push(input)
      },
    }
    // keep the type without importing Solid: reassign for callers
    return clients as never as import("./checkout-handoff").HandoffMoveClients
  }

  test("moves to an existing worktree, archives the source, and starts a fresh destination session", async () => {
    const logs = recordings()
    const result = await carryHandoffContext({
      clients: makeClients(logs),
      from: "/repo-wt",
      to: "/repo",
      sourceSessionID: "ses_src",
    })
    expect(logs.handoff).toEqual([{ from: "/repo-wt", to: "/repo" }])
    expect(logs.created).toEqual([{ directory: "/repo" }])
    expect(logs.archived).toEqual([{ sessionID: "ses_src", directory: "/repo-wt" }])
    expect(result).toEqual({ directory: "/repo", sessionID: "ses_1", movedSessionID: "ses_src" })
  })

  test("still allows the move with a fresh session when the source session is missing", async () => {
    const logs = recordings()
    const result = await carryHandoffContext({
      clients: makeClients(logs),
      from: "/repo-wt",
      to: "/repo",
    })
    expect(logs.created).toEqual([{ directory: "/repo" }])
    expect(logs.archived).toEqual([])
    expect(result).toEqual({ directory: "/repo", sessionID: "ses_1" })
  })

  test("endpoint failure aborts the move before creating a destination session", async () => {
    const logs = recordings()
    const clients = {
      handoffEndpoint: () => Promise.reject(new Error("destination does not exist")),
      createSession: makeClients(logs).createSession as never,
      archiveSession: makeClients(logs).archiveSession as never,
    }
    const result = await carryHandoffContext({
      clients: clients as never as import("./checkout-handoff").HandoffMoveClients,
      from: "/repo-wt",
      to: "/missing",
      sourceSessionID: "ses_src",
    }).catch(() => undefined)
    expect(result).toBeUndefined()
    expect(logs.created).toEqual([])
    expect(logs.archived).toEqual([])
  })
})

describe("firstPromptText", () => {
  test("returns the oldest user message's non-synthetic text parts", () => {
    expect(
      firstPromptText({
        messages: [
          {
            id: "msg_2",
            role: "user",
            parts: [{ type: "text", text: "second" }],
          },
          {
            id: "msg_1",
            role: "user",
            parts: [{ type: "text", text: "fix the  " }, { type: "text", text: "login bug", synthetic: true }],
          },
        ],
      }),
    ).toBe("fix the")
  })

  test("returns an empty string when there are no user messages", () => {
    expect(firstPromptText({ messages: [{ id: "msg_1", role: "assistant", parts: [] }] })).toBe("")
  })
})
