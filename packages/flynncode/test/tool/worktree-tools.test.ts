import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { SessionProjector } from "@flynncode/core/session/projector"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { Ripgrep } from "@flynncode/core/ripgrep"
import type { PermissionV1 } from "@flynncode/core/v1/permission"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { SessionFolderSwitch } from "@/session/folder-switch"
import { MessageID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { EnterWorktreeTool } from "@/tool/enter-worktree"
import { ExitWorktreeTool } from "@/tool/exit-worktree"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ALREADY_SWITCHED, NOT_ROOT } from "@/tool/worktree/guard"
import { Worktree } from "@/worktree"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Config.node,
      CrossSpawnSpawner.node,
      Database.node,
      EventV2Bridge.node,
      FSUtil.node,
      Git.node,
      InstanceStore.node,
      Project.node,
      Ripgrep.node,
      RuntimeFlags.node,
      Session.node,
      SessionFolderSwitch.node,
      SessionProjector.node,
      SessionStatus.node,
      Truncate.node,
      Worktree.node,
    ]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)

type Ask = { permission: string; patterns: string[]; metadata: Record<string, unknown> }

const ctx = (
  sessionID: SessionID,
  input: { asks?: Ask[]; ruleset?: PermissionV1.Ruleset; onAsk?: (ask: Ask) => Effect.Effect<void> } = {},
) =>
  ({
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    // The real ask evaluates the agent's ruleset; a deny fails the call.
    ask: (req: Ask) =>
      Effect.gen(function* () {
        input.asks?.push({ permission: req.permission, patterns: req.patterns, metadata: req.metadata })
        if (input.onAsk) yield* input.onAsk(req)
        if (Permission.evaluate(req.permission, req.patterns[0], input.ruleset ?? []).action === "deny")
          return yield* Effect.die(new Error(`denied ${req.permission}`))
      }),
    extra: {},
  }) as unknown as Tool.Context

const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  return Cause.pretty(exit.cause)
}

const tools = Effect.gen(function* () {
  return {
    enter: yield* Tool.init(yield* EnterWorktreeTool),
    exit: yield* Tool.init(yield* ExitWorktreeTool),
  }
})

// Every test gets its own repository and runs in its instance, through the
// same instance store the worktree service and the tools use.
const inRepo = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>, options: { git?: boolean } = { git: true }) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: options.git })
    const store = yield* InstanceStore.Service
    return yield* store.provide({ directory: dir }, body(dir))
  })

// The prompt loop runs the step after a folder switch in the new folder's instance.
const inFolder = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return yield* store.provide({ directory }, effect)
  })

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const gitSvc = yield* Git.Service
    const result = yield* gitSvc.run(args, { cwd })
    return { code: result.exitCode, text: result.stdout.toString("utf8").trim() }
  })

const exists = (target: string) =>
  Effect.promise(() =>
    fs.stat(target).then(
      () => true,
      () => false,
    ),
  )

describe("enter_worktree", () => {
  it.live(
    "asks with the branch and path, creates the worktree, moves the session and keeps other metadata",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "root", metadata: { keep: "me" } })
          const t = yield* tools
          const asks: Ask[] = []
          const existedAtAsk: boolean[] = []
          const result = yield* t.enter.execute(
            { name: "Feature X" },
            ctx(session.id, {
              asks,
              onAsk: (ask) => exists(ask.patterns[1]).pipe(Effect.map((found) => void existedAtAsk.push(found))),
            }),
          )

          const directory = path.join(dir, ".opencode", "worktrees", "feature-x")
          expect(asks).toEqual([
            {
              permission: "worktree",
              patterns: ["opencode/feature-x", directory],
              metadata: { action: "enter", branch: "opencode/feature-x", path: directory },
            },
          ])
          // The ask comes before anything is created.
          expect(existedAtAsk).toEqual([false])
          expect(yield* exists(directory)).toBe(true)
          expect((yield* git(directory, "symbolic-ref", "--short", "HEAD")).text).toBe("opencode/feature-x")

          const after = yield* sessions.get(session.id)
          expect(after.directory).toBe(directory)
          expect(after.metadata).toEqual({ keep: "me", worktree: directory, enteredFrom: dir, disposable: true })
          expect(result.metadata.worktree).toEqual({ action: "enter", branch: "opencode/feature-x", path: directory })
          expect(result.output).toContain(directory)
          expect(result.output).toContain("opencode/feature-x")
        }),
      ),
    30000,
  )

  it.live(
    "names the branch after the session without a name",
    () =>
      inRepo(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "root" })
          const t = yield* tools
          const result = yield* t.enter.execute({}, ctx(session.id))
          const slug = session.id.toLowerCase().replace(/[^a-z0-9]+/g, "-")
          expect(result.metadata.worktree?.branch).toBe(`opencode/session-${slug}`)
        }),
      ),
    30000,
  )

  it.live(
    "a denied ask creates nothing and leaves the session in place",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "root" })
          const t = yield* tools
          const ruleset: PermissionV1.Ruleset = [{ permission: "worktree", pattern: "*", action: "deny" }]
          const exit = yield* t.enter.execute({ name: "denied" }, ctx(session.id, { ruleset })).pipe(Effect.exit)
          expect(failure(exit)).toContain("denied worktree")
          expect(yield* exists(path.join(dir, ".opencode", "worktrees", "denied"))).toBe(false)
          expect((yield* git(dir, "branch", "--list", "opencode/denied")).text).toBe("")
          expect((yield* sessions.get(session.id)).directory).toBe(dir)
        }),
      ),
    30000,
  )

  it.live(
    "refuses outside a git repository",
    () =>
      inRepo(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const session = yield* sessions.create({ title: "root" })
            const t = yield* tools
            const asks: Ask[] = []
            const exit = yield* t.enter.execute({}, ctx(session.id, { asks })).pipe(Effect.exit)
            expect(failure(exit)).toContain("needs a git repository")
            expect(asks).toEqual([])
            expect((yield* sessions.get(session.id)).directory).toBe(dir)
          }),
        { git: false },
      ),
    30000,
  )

  it.live(
    "refuses in a sub-agent session",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "parent" })
          const child = yield* sessions.create({ title: "child", parentID: parent.id })
          const t = yield* tools
          expect(failure(yield* t.enter.execute({}, ctx(child.id)).pipe(Effect.exit))).toContain(NOT_ROOT)
          expect((yield* sessions.get(child.id)).directory).toBe(dir)
        }),
      ),
    30000,
  )

  it.live(
    "refuses a second worktree while inside an entered one",
    () =>
      inRepo(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "root" })
          const t = yield* tools
          const first = yield* t.enter.execute({ name: "one" }, ctx(session.id))
          const directory = first.metadata.worktree!.path
          const asks: Ask[] = []
          const exit = yield* inFolder(directory, t.enter.execute({ name: "two" }, ctx(session.id, { asks }))).pipe(
            Effect.exit,
          )
          expect(failure(exit)).toContain("call exit_worktree before entering another")
          expect(asks).toEqual([])
          expect((yield* sessions.get(session.id)).directory).toBe(directory)
        }),
      ),
    30000,
  )

  it.live(
    "refuses when the session's folder already changed in this step",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "root" })
          const elsewhere = path.join(dir, "elsewhere")
          yield* Effect.promise(() => fs.mkdir(elsewhere))
          yield* sessions.setDirectory({ sessionID: session.id, directory: elsewhere })
          const t = yield* tools
          expect(failure(yield* t.enter.execute({}, ctx(session.id)).pipe(Effect.exit))).toContain(ALREADY_SWITCHED)
          expect(failure(yield* t.exit.execute({ action: "keep" }, ctx(session.id)).pipe(Effect.exit))).toContain(
            "has not entered one",
          )
        }),
      ),
    30000,
  )
})

describe("exit_worktree", () => {
  const entered = (name: string, metadata?: Record<string, unknown>) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "root", metadata })
      const t = yield* tools
      const result = yield* t.enter.execute({ name }, ctx(session.id))
      return { session, tools: t, directory: result.metadata.worktree!.path, branch: result.metadata.worktree!.branch! }
    })

  it.live(
    "keep moves back, leaves the worktree and clears only the binding",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const e = yield* entered("keep-me", { keep: "me" })
          const asks: Ask[] = []
          const result = yield* inFolder(
            e.directory,
            e.tools.exit.execute({ action: "keep" }, ctx(e.session.id, { asks })),
          )

          expect(asks).toEqual([])
          const after = yield* sessions.get(e.session.id)
          expect(after.directory).toBe(dir)
          expect(after.metadata).toEqual({ keep: "me" })
          expect(yield* exists(e.directory)).toBe(true)
          expect((yield* git(dir, "branch", "--list", e.branch)).text).toContain(e.branch)
          expect(result.metadata.worktree).toEqual({ action: "exit", path: dir, from: e.directory, removed: false })
          expect(result.output).toContain("was kept")
        }),
      ),
    30000,
  )

  it.live(
    "remove deletes a worktree that would lose nothing, without asking, and keeps the branch",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const e = yield* entered("clean")
          const asks: Ask[] = []
          const result = yield* inFolder(
            e.directory,
            e.tools.exit.execute({ action: "remove" }, ctx(e.session.id, { asks })),
          )

          expect(asks).toEqual([])
          expect((yield* sessions.get(e.session.id)).directory).toBe(dir)
          expect(yield* exists(e.directory)).toBe(false)
          expect((yield* git(dir, "branch", "--list", e.branch)).text).toContain(e.branch)
          expect(result.metadata.worktree).toEqual({ action: "exit", path: dir, from: e.directory, removed: true })
        }),
      ),
    30000,
  )

  it.live(
    "remove refuses, listing the loss, when work would be lost and changes nothing",
    () =>
      inRepo(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const e = yield* entered("dirty", { keep: "me" })
          yield* Effect.promise(() => Bun.write(path.join(e.directory, "notes.txt"), "work in progress\n"))
          const asks: Ask[] = []
          const exit = yield* inFolder(
            e.directory,
            e.tools.exit.execute({ action: "remove" }, ctx(e.session.id, { asks })),
          ).pipe(Effect.exit)

          const message = failure(exit)
          expect(message).toContain("Not removed")
          expect(message).toContain("1 uncommitted change")
          expect(asks).toEqual([])
          const after = yield* sessions.get(e.session.id)
          expect(after.directory).toBe(e.directory)
          expect(after.metadata?.enteredFrom).toBeDefined()
          expect(yield* exists(path.join(e.directory, "notes.txt"))).toBe(true)
        }),
      ),
    30000,
  )

  it.live(
    "remove with discard_changes asks under worktree with the loss, then removes the worktree and its branch",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const e = yield* entered("discard")
          yield* Effect.promise(() => Bun.write(path.join(e.directory, "notes.txt"), "throw away\n"))
          const asks: Ask[] = []
          const result = yield* inFolder(
            e.directory,
            e.tools.exit.execute({ action: "remove", discard_changes: true }, ctx(e.session.id, { asks })),
          )

          expect(asks).toHaveLength(1)
          expect(asks[0].permission).toBe("worktree")
          expect(asks[0].patterns).toEqual([`discard ${e.directory} (branch ${e.branch}): 1 uncommitted change`])
          expect((yield* sessions.get(e.session.id)).directory).toBe(dir)
          expect(yield* exists(e.directory)).toBe(false)
          expect((yield* git(dir, "branch", "--list", e.branch)).text).toBe("")
          expect(result.metadata.worktree?.removed).toBe(true)
        }),
      ),
    30000,
  )

  it.live(
    "a denied discard leaves the session and the worktree in place",
    () =>
      inRepo(() =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const e = yield* entered("keep-on-deny")
          yield* Effect.promise(() => Bun.write(path.join(e.directory, "notes.txt"), "keep\n"))
          const ruleset: PermissionV1.Ruleset = [{ permission: "worktree", pattern: "*", action: "deny" }]
          const exit = yield* inFolder(
            e.directory,
            e.tools.exit.execute({ action: "remove", discard_changes: true }, ctx(e.session.id, { ruleset })),
          ).pipe(Effect.exit)
          expect(failure(exit)).toContain("denied worktree")
          expect((yield* sessions.get(e.session.id)).directory).toBe(e.directory)
          expect(yield* exists(path.join(e.directory, "notes.txt"))).toBe(true)
        }),
      ),
    30000,
  )

  it.live(
    "falls back to the project's main folder when the folder it came from is gone",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const sub = path.join(dir, "sub")
          yield* Effect.promise(() => fs.mkdir(sub))
          const session = yield* sessions.create({ title: "root" })
          yield* sessions.setDirectory({ sessionID: session.id, directory: sub })
          const t = yield* tools
          const result = yield* inFolder(sub, t.enter.execute({ name: "from-sub" }, ctx(session.id)))
          const directory = result.metadata.worktree!.path
          expect((yield* sessions.get(session.id)).metadata?.enteredFrom).toBe(sub)
          yield* Effect.promise(() => fs.rm(sub, { recursive: true }))

          const exited = yield* inFolder(directory, t.exit.execute({ action: "keep" }, ctx(session.id)))
          expect((yield* sessions.get(session.id)).directory).toBe(dir)
          expect(exited.output).toContain(`${sub} no longer exists`)
          expect(exited.metadata.worktree?.path).toBe(dir)
        }),
      ),
    30000,
  )

  it.live(
    "removal waits until no session runs in the worktree's instance",
    () =>
      inRepo((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const status = yield* SessionStatus.Service
          const e = yield* entered("busy")
          // This turn started inside the worktree, so its run lives in that instance.
          yield* inFolder(e.directory, status.set(e.session.id, { type: "busy" }))
          const result = yield* inFolder(e.directory, e.tools.exit.execute({ action: "remove" }, ctx(e.session.id)))

          expect((yield* sessions.get(e.session.id)).directory).toBe(dir)
          expect(result.output).toContain("still in use by this turn")
          expect(result.metadata.worktree).toMatchObject({ removed: false, pending: true })
          expect(yield* exists(e.directory)).toBe(true)

          yield* inFolder(e.directory, status.set(e.session.id, { type: "idle" }))
          yield* pollWithTimeout(
            exists(e.directory).pipe(Effect.map((found) => (found ? undefined : true))),
            "the worktree was never removed",
            "10 seconds",
          )
        }),
      ),
    30000,
  )
})

describe("worktree permission", () => {
  it.live(
    "build asks before worktree actions by default",
    () =>
      inRepo(() =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const build = yield* agents.get("build")
          expect(Permission.evaluate("worktree", "opencode/x", build.permission).action).toBe("ask")
        }),
      ),
    30000,
  )

  it.effect("a worktree deny hides both tools", () =>
    Effect.sync(() => {
      const hidden = Permission.disabled(
        ["enter_worktree", "exit_worktree", "read"],
        [{ permission: "worktree", pattern: "*", action: "deny" }],
      )
      expect([...hidden].toSorted()).toEqual(["enter_worktree", "exit_worktree"])
    }),
  )
})
