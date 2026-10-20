import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@flynncode/sdk/v2/client"
import { isLiveTerminal, sessionWaitingTerminal } from "./session-request-tree"

const session = (id: string, parentID?: string): Session =>
  ({
    id,
    slug: id,
    projectID: "prj_1",
    directory: "/repo",
    parentID,
    title: id,
  }) as Session

const shellPart = (input: {
  sessionID: string
  messageID?: string
  tool?: string
  status?: "running" | "completed" | "error"
  ptyID?: string
  interactive?: boolean
  command?: string
}): Part =>
  ({
    id: "prt_1",
    sessionID: input.sessionID,
    messageID: input.messageID ?? "msg_1",
    type: "tool",
    callID: "call_1",
    tool: input.tool ?? "bash",
    state: {
      status: input.status ?? "running",
      input: { command: input.command ?? "sudo id" },
      title: input.command ?? "sudo id",
      metadata: input.ptyID
        ? { ptyID: input.ptyID, interactive: input.interactive ?? true }
        : {},
      time: { start: 1 },
    },
  }) as Part

const message = (sessionID: string, id: string): Message =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created: 1 },
  }) as Message

describe("sessionWaitingTerminal", () => {
  test("finds a running interactive shell in a descendant session", () => {
    const sessions = [session("ses_main"), session("ses_child", "ses_main")]
    const messages = { ses_child: [message("ses_child", "msg_1")] }
    const parts = { msg_1: [shellPart({ sessionID: "ses_child", ptyID: "pty_abc" })] }

    expect(sessionWaitingTerminal(sessions, messages, parts, "ses_main")).toEqual({
      sessionID: "ses_child",
      ptyID: "pty_abc",
      command: "sudo id",
    })
  })

  test("ignores the viewed session's own shell", () => {
    const sessions = [session("ses_main")]
    const messages = { ses_main: [message("ses_main", "msg_1")] }
    const parts = { msg_1: [shellPart({ sessionID: "ses_main", ptyID: "pty_abc" })] }

    expect(sessionWaitingTerminal(sessions, messages, parts, "ses_main")).toBeUndefined()
  })

  test("ignores shells that are not interactive or not shells", () => {
    const sessions = [session("ses_main"), session("ses_child", "ses_main")]
    const messages = { ses_child: [message("ses_child", "msg_1")] }
    const parts = {
      msg_1: [
        shellPart({ sessionID: "ses_child", ptyID: "pty_plain", interactive: false }),
        shellPart({ sessionID: "ses_child", tool: "read", ptyID: "pty_read" }),
      ],
    }

    expect(sessionWaitingTerminal(sessions, messages, parts, "ses_main")).toBeUndefined()
  })

  test("keeps a shell that finished while its terminal is still open", () => {
    // The shell tool leaves the terminal open on timeout, so the part can be
    // completed while the PTY still waits for the user.
    const sessions = [session("ses_main"), session("ses_child", "ses_main")]
    const messages = { ses_child: [message("ses_child", "msg_1")] }
    const parts = { msg_1: [shellPart({ sessionID: "ses_child", status: "completed", ptyID: "pty_open" })] }

    expect(sessionWaitingTerminal(sessions, messages, parts, "ses_main")?.ptyID).toBe("pty_open")
  })

  test("finds a waiting shell nested deeper in the tree", () => {
    const sessions = [
      session("ses_main"),
      session("ses_child", "ses_main"),
      session("ses_grandchild", "ses_child"),
    ]
    const messages = { ses_grandchild: [message("ses_grandchild", "msg_1")] }
    const parts = { msg_1: [shellPart({ sessionID: "ses_grandchild", ptyID: "pty_deep" })] }

    expect(sessionWaitingTerminal(sessions, messages, parts, "ses_main")?.ptyID).toBe("pty_deep")
  })

  test("ignores sessions that are not descendants", () => {
    const sessions = [session("ses_main"), session("ses_other")]
    const messages = { ses_other: [message("ses_other", "msg_1")] }
    const parts = { msg_1: [shellPart({ sessionID: "ses_other", ptyID: "pty_other" })] }

    expect(sessionWaitingTerminal(sessions, messages, parts, "ses_main")).toBeUndefined()
  })
})

describe("isLiveTerminal", () => {
  test("only a terminal the server still lists is live", () => {
    const live = new Set(["pty_open"])
    expect(isLiveTerminal("pty_open", live)).toBe(true)
    expect(isLiveTerminal("pty_gone", live)).toBe(false)
  })
})
