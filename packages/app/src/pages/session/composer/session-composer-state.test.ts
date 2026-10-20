import { beforeAll, describe, expect, mock, test } from "bun:test"
import type {
  Message,
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  Todo,
} from "@flynncode/sdk/v2/client"
import type { ApprovalMode, SandboxLevel } from "@/context/permission"

// The `solid` test condition resolves solid-js to its SSR build, where
// createEffect is a no-op and stores are not reactive. The composer lifecycle
// lives inside a createEffect, so these mocks point solid-js and
// solid-js/store at their client builds. Because mock.module must be
// registered before any module in the graph resolves solid-js, the modules
// under test are imported dynamically inside beforeAll (matching the
// comments.test.ts / file-tree.test.ts convention).

let composer: typeof import("./session-composer-state")
let requestTree: typeof import("./session-request-tree")
let sessions: typeof import("@/context/server-session")
let solid: typeof import("solid-js")
let solidStore: typeof import("solid-js/store")

// Per-test state read by the context mocks.
let currentServer: ReturnType<(typeof import("@/context/server-session"))["createServerSession"]>
let currentParams: () => { id: string | undefined }
let setCurrentParams: (id: string | undefined) => void
// The session tree, messages and parts the sync mock exposes, and the live
// terminals the server reports.
let syncData: {
  session: Session[]
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}
let livePtyIDs: string[] = []

// Mutable per-test state read by the permission context mock. Defaults mirror
// the real context (workspace-write sandbox, manual approvals, no auto-respond
// recorded); tests override fields to assert controller delegation.
const permissionMock: {
  autoResponds: () => boolean
  sandboxLevel: () => SandboxLevel
  approvalMode: () => ApprovalMode
  setApprovalMode: (sessionID: string, directory: string | undefined, mode: ApprovalMode) => void
} = {
  autoResponds: () => true,
  sandboxLevel: () => "workspace-write",
  approvalMode: () => "manual",
  setApprovalMode: () => undefined,
}

beforeAll(async () => {
  // @ts-expect-error - deep import has no declaration file
  mock.module("solid-js", async () => await import("solid-js/dist/solid.js"))
  // @ts-expect-error - deep import has no declaration file
  mock.module("solid-js/store", async () => await import("solid-js/store/dist/store.js"))
  mock.module("@solidjs/router", () => ({
    useParams: () => currentParams(),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => () => ({
      api: { permission: { reply: () => Promise.resolve() } },
      client: { pty: { list: () => Promise.resolve({ data: livePtyIDs.map((id) => ({ id })) }) } },
      directory: "/repo",
    }),
  }))
  mock.module("@/context/permission", () => ({
    usePermission: () => permissionMock,
  }))
  mock.module("@/context/language", () => ({
    useLanguage: () => ({ t: () => "" }),
  }))
  mock.module("@/utils/toast", () => ({
    showToast: () => undefined,
  }))
  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({ session: currentServer }),
  }))
  mock.module("@/context/sync", () => ({
    // Mirrors createDirSyncContext routing (directory-sync.ts): session
    // fields read from and write to the shared server session store, so
    // clear() via sync().set and reads via serverSync().session.data.todo
    // are the same store, exactly as in production.
    useSync: () => () => ({
      data: {
        session_working: currentServer.data.session_working.bind(currentServer.data),
        session: syncData.session,
        message: syncData.message,
        part: syncData.part,
        permission: {} as Record<string, PermissionRequest[]>,
        question: {} as Record<string, QuestionRequest[]>,
      },
      set: currentServer.set,
    }),
  }))
  composer = await import("./session-composer-state")
  requestTree = await import("./session-request-tree")
  sessions = await import("@/context/server-session")
  solid = await import("solid-js")
  solidStore = await import("solid-js/store")
})

const session = (input: { id: string; parentID?: string }): Session => ({
  id: input.id,
  slug: input.id,
  projectID: "project",
  directory: "/repo",
  title: input.id,
  version: "1",
  parentID: input.parentID,
  time: { created: 1, updated: 1 },
})

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    questions: [],
  }) as QuestionRequest

const todo = (content: string, status: Todo["status"] = "pending"): Todo => ({
  content,
  status,
  priority: "high",
})

const pendingTodos = (sessionID: string) => [todo(`${sessionID}: pending work`), todo(`${sessionID}: queued work`)]

const completeTodos = (sessionID: string) => [
  { ...todo(`${sessionID}: done work`), status: "completed" },
  { ...todo(`${sessionID}: cancelled work`), status: "cancelled" },
]

type ControllerHarness = {
  controller: ReturnType<(typeof import("./session-composer-state"))["createSessionComposerController"]>
  server: ReturnType<(typeof import("@/context/server-session"))["createServerSession"]>
  setTodo: (sessionID: string, todos: Todo[]) => void
  setStatus: (sessionID: string, status: { type: string }) => void
  setParams: (id: string | undefined) => void
  dispose: () => void
}

function harness(id = "s1"): ControllerHarness {
  const [params, setParams] = solidStore.createStore<{ id: string | undefined }>({ id })
  currentParams = () => params
  setCurrentParams = (next) => setParams({ id: next })
  currentServer = sessions.createServerSession({} as OpencodeClient)
  currentServer.remember(session({ id: "s1", parentID: "root" }))
  currentServer.remember(session({ id: "s2", parentID: "root" }))
  if (!syncData) syncData = { session: [], message: {}, part: {} }
  let controller: ControllerHarness["controller"]
  const dispose = solid.createRoot((d) => {
    controller = composer.createSessionComposerController({ closeMs: 0 })
    return d
  })
  return {
    controller: controller!,
    server: currentServer,
    setTodo: (sessionID, todos) => currentServer.apply({ type: "todo.updated", properties: { sessionID, todos } }),
    setStatus: (sessionID, status) =>
      currentServer.apply({ type: "session.status", properties: { sessionID, status } }),
    setParams: (next) => setCurrentParams(next),
    dispose,
  }
}

function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = 100
    const check = () => {
      if (condition()) {
        resolve()
        return
      }
      if (remaining <= 0) {
        reject(new Error("waitFor timed out"))
        return
      }
      remaining -= 1
      setTimeout(check, 0)
    }
    check()
  })
}

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(requestTree.sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(requestTree.sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(requestTree.sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(
      requestTree.sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"),
    )?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(requestTree.sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionQuestionRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(requestTree.sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(requestTree.sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })
})

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(composer.todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(composer.todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(composer.todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  test("clears stale todos when the turn ends", () => {
    expect(composer.todoState({ count: 2, done: false, live: false })).toBe("clear")
  })

  test("clears completed todos when the session is no longer live", () => {
    expect(composer.todoState({ count: 2, done: true, live: false })).toBe("clear")
  })
})

describe("todoDockAtBoundary", () => {  test("shows active todos when entering a session", () => {
    expect(composer.todoDockAtBoundary("open")).toBe(true)
  })

  test("hides completed todos when entering a session", () => {
    expect(composer.todoDockAtBoundary("close")).toBe(false)
  })
})

describe("session composer todo lifecycle", () => {
  test("todo.updated while the session is busy opens the dock", async () => {
    const h = harness("s1")
    h.setStatus("s1", { type: "busy" })
    expect(h.controller.dock()).toBe(false)

    h.setTodo("s1", pendingTodos("s1"))

    await waitFor(() => h.controller.dock() === true)
    expect(h.controller.todos()).toEqual(pendingTodos("s1"))
    h.dispose()
  })

  test("clear on idle empties todos and leaves the dock hidden", async () => {
    const h = harness("s1")
    h.setStatus("s1", { type: "busy" })
    h.setTodo("s1", pendingTodos("s1"))
    await waitFor(() => h.controller.dock() === true)

    h.setTodo("s1", completeTodos("s1"))
    h.setStatus("s1", { type: "idle" })

    await waitFor(() => (h.server.data.todo["s1"] ?? []).length === 0)
    expect(h.server.data.todo["s1"]).toEqual([])
    expect(h.controller.todos()).toEqual([])
    expect(h.controller.dock()).toBe(false)
    h.dispose()
  })

  test("switching session ids returns the other session's todos instead of the previous session's", async () => {
    const h = harness("s1")
    h.setStatus("s1", { type: "busy" })
    h.setTodo("s1", pendingTodos("s1"))
    await waitFor(() => h.controller.dock() === true)

    h.setStatus("s2", { type: "busy" })
    h.setTodo("s2", pendingTodos("s2"))
    h.setParams("s2")

    await waitFor(() => h.controller.todos().length === 2 && h.controller.todos()[0]?.content.startsWith("s2"))
    expect(h.controller.todos()).toEqual(pendingTodos("s2"))
    expect(h.controller.todos()).not.toEqual(pendingTodos("s1"))
    h.dispose()
  })

  test("stale todos arriving after idle do not reopen the dock", async () => {
    const h = harness("s1")
    h.setStatus("s1", { type: "busy" })
    h.setTodo("s1", pendingTodos("s1"))
    await waitFor(() => h.controller.dock() === true)

    h.setStatus("s1", { type: "idle" })
    await waitFor(() => h.controller.dock() === false)

    h.setTodo("s1", pendingTodos("s1"))
    await waitFor(() => (h.server.data.todo["s1"] ?? []).length === 0)

    expect(h.server.data.todo["s1"]).toEqual([])
    expect(h.controller.dock()).toBe(false)
    h.dispose()
  })
})

describe("permission dock wiring", () => {
  test("exposes the session sandbox level", () => {
    permissionMock.sandboxLevel = () => "readonly"
    const h = harness("s1")
    expect(h.controller.permissionSandbox()).toBe("readonly")
    h.dispose()
  })

  test("exposes the session approval mode", () => {
    permissionMock.approvalMode = () => "auto"
    const h = harness("s1")
    expect(h.controller.permissionApprovalMode()).toBe("auto")
    h.dispose()
  })

  test("sandbox blockers are derived for bash and write tools under readonly", () => {
    expect(composer.permissionSandboxBlocked("readonly", "bash")).toBe(true)
    expect(composer.permissionSandboxBlocked("readonly", "edit")).toBe(true)
    expect(composer.permissionSandboxBlocked("workspace-write", "bash")).toBe(false)
    expect(composer.permissionSandboxBlocked("full-access", "bash")).toBe(false)
    expect(composer.permissionSandboxBlocked("readonly", "read")).toBe(false)
  })

  test("forwards mode changes with the session id and directory", () => {
    const calls: { sessionID: string; directory: string | undefined; mode: ApprovalMode }[] = []
    permissionMock.setApprovalMode = (sessionID, directory, mode) => {
      calls.push({ sessionID, directory, mode })
    }
    const h = harness("s1")
    h.controller.setPermissionApprovalMode("accept-edits")
    expect(calls).toEqual([{ sessionID: "s1", directory: "/repo", mode: "accept-edits" }])
    h.dispose()
  })
})

describe("waiting terminal wiring", () => {
  const waitingShell = (sessionID: string, ptyID: string) =>
    ({
      id: "prt_1",
      sessionID,
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "sudo id" },
        title: "sudo id",
        metadata: { ptyID, interactive: true },
        time: { start: 1 },
      },
    }) as Part

  test("surfaces a subagent terminal that is still waiting", async () => {
    syncData = {
      session: [session({ id: "s1" }), session({ id: "s2", parentID: "s1" })],
      message: { s2: [{ id: "msg_1", sessionID: "s2", role: "assistant", time: { created: 1 } } as Message] },
      part: { msg_1: [waitingShell("s2", "pty_open")] },
    }
    livePtyIDs = ["pty_open"]
    const h = harness("s1")
    await waitFor(() => h.controller.waitingTerminal() !== undefined)
    expect(h.controller.waitingTerminal()).toMatchObject({ ptyID: "pty_open", sessionID: "s2" })
    h.dispose()
  })

  test("drops the card once the terminal is gone", async () => {
    syncData = {
      session: [session({ id: "s1" }), session({ id: "s2", parentID: "s1" })],
      message: { s2: [{ id: "msg_1", sessionID: "s2", role: "assistant", time: { created: 1 } } as Message] },
      part: { msg_1: [waitingShell("s2", "pty_open")] },
    }
    livePtyIDs = []
    const h = harness("s1")
    await waitFor(() => h.controller.waitingTerminal() === undefined)
    expect(h.controller.waitingTerminal()).toBeUndefined()
    h.dispose()
  })

  test("ignores the viewed session's own terminal", async () => {
    syncData = {
      session: [session({ id: "s1" })],
      message: { s1: [{ id: "msg_1", sessionID: "s1", role: "assistant", time: { created: 1 } } as Message] },
      part: { msg_1: [waitingShell("s1", "pty_open")] },
    }
    livePtyIDs = ["pty_open"]
    const h = harness("s1")
    await waitFor(() => h.controller.waitingTerminal() === undefined)
    expect(h.controller.waitingTerminal()).toBeUndefined()
    h.dispose()
  })
})
