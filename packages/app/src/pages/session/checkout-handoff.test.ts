import { describe, expect, test } from "bun:test"
import { carryHandoffContext, checkoutHandoff, firstPromptText, handoffErrorMessage, handoffFollowHref, handoffPromptOutcome } from "./checkout-handoff"

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
    ).toEqual({ ok: true, targets: ["/repo"], create: false })
  })

  test("offers every other worktree when leaving the primary checkout", () => {
    expect(
      checkoutHandoff({
        current: "/repo",
        primary: "/repo",
        worktrees: [{ directory: "/repo" }, { directory: "/wt-a" }, { directory: "/wt-b" }],
        git: true,
      }),
    ).toEqual({ ok: true, targets: ["/wt-a", "/wt-b"], create: false })
  })

  test("asks to create a worktree when the primary checkout has none", () => {
    expect(
      checkoutHandoff({
        current: "/repo",
        primary: "/repo",
        worktrees: [{ directory: "/repo" }],
        git: true,
      }),
    ).toEqual({ ok: true, targets: [], create: true })
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

  test("leaving a worktree opens the rebound source session without archiving it", async () => {
    const logs = recordings()
    const result = await carryHandoffContext({
      clients: makeClients(logs),
      from: "/repo-wt",
      to: "/repo",
      fromPrimary: false,
      sourceSessionID: "ses_src",
    })
    expect(logs.handoff).toEqual([{ from: "/repo-wt", to: "/repo" }])
    expect(logs.created).toEqual([])
    expect(logs.archived).toEqual([])
    expect(result).toEqual({ directory: "/repo", sessionID: "ses_src" })
  })

  test("leaving the primary checkout archives the source and starts a destination session", async () => {
    const logs = recordings()
    const result = await carryHandoffContext({
      clients: makeClients(logs),
      from: "/repo",
      to: "/repo-wt",
      fromPrimary: true,
      sourceSessionID: "ses_src",
    })
    expect(logs.created).toEqual([{ directory: "/repo-wt" }])
    expect(logs.archived).toEqual([{ sessionID: "ses_src", directory: "/repo" }])
    expect(result).toEqual({ directory: "/repo-wt", sessionID: "ses_1", created: true })
  })

  test("still allows the move with a fresh session when the source session is missing", async () => {
    const logs = recordings()
    const result = await carryHandoffContext({
      clients: makeClients(logs),
      from: "/repo-wt",
      to: "/repo",
      fromPrimary: false,
    })
    expect(logs.created).toEqual([{ directory: "/repo" }])
    expect(logs.archived).toEqual([])
    expect(result).toEqual({ directory: "/repo", sessionID: "ses_1", created: true })
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
      fromPrimary: false,
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

describe("handoffPromptOutcome", () => {
  test("carries a real prompt", () => {
    expect(handoffPromptOutcome({ sessionFound: true, messagesLoaded: true, prompt: "fix login" })).toBe("carry")
  })

  test("stays silent when the session legitimately has no prompt", () => {
    expect(handoffPromptOutcome({ sessionFound: true, messagesLoaded: true, prompt: "" })).toBe("empty-loaded")
  })

  test("flags an unresolved prompt when the session is missing or messages are unloaded", () => {
    expect(handoffPromptOutcome({ sessionFound: false, messagesLoaded: false, prompt: "" })).toBe("empty-unresolved")
    expect(handoffPromptOutcome({ sessionFound: true, messagesLoaded: false, prompt: "" })).toBe("empty-unresolved")
  })
})

describe("handoffErrorMessage", () => {
  test("extracts the endpoint message from a WorktreeError shape", () => {
    expect(handoffErrorMessage({ name: "WorktreeHandoffFailedError", data: { message: "Destination worktree does not exist" } })).toBe(
      "Destination worktree does not exist",
    )
  })

  test("returns undefined for non-WorktreeError shapes", () => {
    expect(handoffErrorMessage(new Error("boom"))).toBeUndefined()
    expect(handoffErrorMessage({ data: {} })).toBeUndefined()
    expect(handoffErrorMessage(undefined)).toBeUndefined()
  })
})

describe("handoffFollowHref", () => {
  const href = (session: { directory: string; id: string }) => `${session.directory}/session/${session.id}`

  test("follows the routed session when its row moved to the handoff target", () => {
    expect(
      handoffFollowHref({ sessionID: "ses_1", rowDirectory: "/repo-wt", target: "/repo-wt", href }),
    ).toBe("/repo-wt/session/ses_1")
  })

  test("suppresses the follow when the row did not move (refused rebind)", () => {
    expect(
      handoffFollowHref({ sessionID: "ses_1", rowDirectory: "/repo", target: "/repo-wt", href }),
    ).toBeUndefined()
  })
  test("suppresses the follow when the row could not be read", () => {
    expect(handoffFollowHref({ sessionID: "ses_1", rowDirectory: undefined, target: "/repo-wt", href })).toBeUndefined()
  })

  test("suppresses the follow without an open routed session", () => {
    expect(handoffFollowHref({ sessionID: undefined, rowDirectory: "/repo-wt", target: "/repo-wt", href })).toBeUndefined()
  })

  test("suppresses the follow when the host supplies no href", () => {
    expect(handoffFollowHref({ sessionID: "ses_1", rowDirectory: "/repo-wt", target: "/repo-wt", href: undefined })).toBeUndefined()
  })

  test("compares targets key-safe so spelling differences do not block the follow", () => {
    expect(handoffFollowHref({ sessionID: "ses_1", rowDirectory: "/repo-wt/", target: "/repo-wt", href })).toBe(
      "/repo-wt/session/ses_1",
    )
  })
})
