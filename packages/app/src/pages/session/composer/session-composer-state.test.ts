import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { OpencodeClient, PermissionRequest, QuestionRequest, Session, Todo } from "@opencode-ai/sdk/v2/client"

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

beforeAll(async () => {
  // @ts-expect-error - deep import has no declaration file
  mock.module("solid-js", async () => await import("solid-js/dist/solid.js"))
  // @ts-expect-error - deep import has no declaration file
  mock.module("solid-js/store", async () => await import("solid-js/store/dist/store.js"))
  mock.module("@solidjs/router", () => ({
    useParams: () => currentParams(),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => () => ({ api: { permission: { reply: () => Promise.resolve() } }, directory: "/repo" }),
  }))
  mock.module("@/context/permission", () => ({
    usePermission: () => ({ autoResponds: () => true }),
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
        session: [] as Session[],
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

describe("todoDockAtBoundary", () => {
  test("shows active todos when entering a session", () => {
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
