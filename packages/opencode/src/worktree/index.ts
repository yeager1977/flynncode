import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { path, filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Config } from "@/config/config"
import { ConfigWorktree } from "@/config/worktree"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { Slug } from "@opencode-ai/core/util/slug"
import { Glob } from "@opencode-ai/core/util/glob"
import { errorMessage } from "../util/error"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { Effect, FileSystem, Layer, Option, Path, Schema, Scope, Context } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { WorktreeEvent } from "@opencode-ai/schema/worktree-event"
import { worktreesToRemove } from "./retention"
import { boundSessions } from "./bound-sessions"

export const Event = WorktreeEvent

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
}).annotate({ identifier: "WorktreeCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeRemoveInput" })
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" })
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export const HandoffInput = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
}).annotate({ identifier: "WorktreeHandoffInput" })
export type HandoffInput = Schema.Schema.Type<typeof HandoffInput>

export class NotGitError extends Schema.TaggedErrorClass<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedErrorClass<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedErrorClass<CreateFailedError>()("WorktreeCreateFailedError", {
  message: Schema.String,
}) {}

export class StartCommandFailedError extends Schema.TaggedErrorClass<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedErrorClass<RemoveFailedError>()("WorktreeRemoveFailedError", {
  message: Schema.String,
}) {}

export class ResetFailedError extends Schema.TaggedErrorClass<ResetFailedError>()("WorktreeResetFailedError", {
  message: Schema.String,
}) {}

export class ListFailedError extends Schema.TaggedErrorClass<ListFailedError>()("WorktreeListFailedError", {
  message: Schema.String,
}) {}

export class HandoffFailedError extends Schema.TaggedErrorClass<HandoffFailedError>()("WorktreeHandoffFailedError", {
  message: Schema.String,
}) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | ListFailedError
  | HandoffFailedError

// Per-worktree include manifest, modeled on `.gitignore` syntax (comments and
// one path pattern per line). Lines naming gitignored/untracked files are
// copied from the primary checkout into each new worktree.
const INCLUDE_FILE = ".worktreeinclude"

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

// Paths from `git status --porcelain=v1 -z`: two XY status bytes per record,
// then a NUL, then the path. Rename records (XY + NUL + new + NUL + old) yield
// only the new path — the checkout surface already decodes octal-escaped
// legacy porcelain output the same way.
// Deleted paths carry no source to copy, so they are dropped here: the
// destination's fresh checkout already has the file when it was never deleted
// there, which matches carrying the source's working state.
function parseStatusZ(text: string) {
  const out: { path: string; deleted: boolean }[] = []
  for (const record of text.split("\0")) {
    if (record.length <= 3) continue
    const status = record.slice(0, 2)
    out.push({ path: record.slice(3), deleted: status.includes("D") })
  }
  return out
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info, Error>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>
  readonly createDisposable: (input: { sessionID: string; name?: string }) => Effect.Effect<Info, Error>
  readonly disposeIfIdle: (input: { directory: string }) => Effect.Effect<boolean, Error>
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>
  // Retention sweep: enumerates owned worktrees as enriched entries and
  // removes the keep-N losers through the non-destructive retire path.
  readonly retire: Effect.Effect<void, Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>
  readonly handoff: (input: HandoffInput) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Worktree") {}

type GitResult = { code: number; text: string; stderr: string }

const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | FileSystem.FileSystem
  | Path.Path
  | AppProcess.Service
  | Git.Service
  | Project.Service
  | InstanceStore.Service
  | Database.Service
  | Config.Service
  | Session.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const fs = yield* FSUtil.Service
    const rawFs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const gitSvc = yield* Git.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service
    const configSvc = yield* Config.Service
    const sessionSvc = yield* Session.Service

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        } satisfies GitResult
      },
      Effect.catch((e) =>
        Effect.succeed({
          code: 1,
          text: "",
          stderr: e instanceof Error ? e.message : String(e),
        } satisfies GitResult),
      ),
    )

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      branchPrefix: string
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name ? (attempt === 0 ? input.name : `${input.name}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `${input.branchPrefix}/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      // The configured location is relative to the project root; an absolute
      // location is honored as-is. When the parent ends up inside the primary
      // checkout, keep it out of git so `git clean -ffdx` cannot sweep it away.
      const wt = ConfigWorktree.settings(yield* configSvc.get())
      const inRepo = !pathSvc.isAbsolute(wt.location)
      const root = inRepo ? pathSvc.join(ctx.worktree, wt.location) : pathSvc.normalize(wt.location)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)
      if (inRepo) yield* ignoreWorktreeRoot(ctx.worktree, wt.location)

      return yield* candidate({
        root,
        branchPrefix: wt.branchPrefix,
        name: input?.name ? slugify(input.name) : "",
        detached: input?.detached,
      })
    })

    // Ignore the worktree root through the repository-local `info/exclude`
    // rather than the user's tracked `.gitignore`. Linked worktrees share the
    // common git dir, so resolve it instead of assuming `<root>/.git`.
    const ignoreWorktreeRoot = Effect.fn("Worktree.ignoreWorktreeRoot")(function* (projectRoot: string, location: string) {
      const common = yield* git(["rev-parse", "--git-common-dir"], { cwd: projectRoot })
      if (common.code !== 0 || !common.text.trim()) return
      const exclude = pathSvc.join(pathSvc.resolve(projectRoot, common.text.trim()), "info", "exclude")
      const entry = `${location.replace(/\/+$/, "")}/`
      const existing = (yield* fs.readFileStringSafe(exclude).pipe(Effect.catch(() => Effect.succeed("")))) ?? ""
      // Match the entry as a whole line so repeated saves do not stack copies.
      if (existing.split("\n").some((line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ""))) return
      const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
      yield* fs
        .writeWithDirs(exclude, `${existing}${prefix}# git worktrees (config.worktree.location)\n${entry}\n`)
        .pipe(Effect.catch(() => Effect.void))
    })

    const setup = Effect.fnUntraced(function* (info: Info) {
      const ctx = yield* InstanceState.context
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        { cwd: ctx.worktree },
      )
      if (created.code !== 0) {
        return yield* new CreateFailedError({
          message: created.stderr || created.text || "Failed to create git worktree",
        })
      }

      yield* project.addSandbox(ctx.project.id, info.directory).pipe(Effect.catch(() => Effect.void))
    })

    const boot = Effect.fnUntraced(function* (info: Info, startCommand?: string) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const projectID = ctx.project.id
      const extra = startCommand?.trim()

      const populated = yield* git(["reset", "--hard"], { cwd: info.directory })
      if (populated.code !== 0) {
        const message = populated.stderr || populated.text || "Failed to populate worktree"
        yield* Effect.logError("worktree checkout failed", { directory: info.directory, message })
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.project.id,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        })
        return
      }

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = errorMessage(error)
            yield* Effect.logError("worktree bootstrap failed", { directory: info.directory, message })
            GlobalBus.emit("event", {
              directory: info.directory,
              project: ctx.project.id,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            })
            return false
          }),
        ),
      )
      if (!booted) return

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })

      yield* runStartScripts(info.directory, { projectID, extra })
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      yield* setup(info)
      yield* carryIncludedFiles(info.directory).pipe(
        Effect.catchCause((cause) => Effect.logWarning("worktree include carry failed", { cause })),
      )
      yield* boot(info, startCommand).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
        Effect.forkIn(scope),
      )
    })

    // Carry gitignored files listed in `<project-root>/.worktreeinclude` from
    // the primary checkout into a freshly created worktree. Only ignored files
    // are carried — tracked files already arrive via the checkout. Patterns
    // support exact paths and simple `*` globs; any failure is a warning, never
    // a failed create.
    const carryIncludedFiles = Effect.fn("Worktree.carryIncludedFiles")(function* (target: string) {
      const ctx = yield* InstanceState.context
      const includeFile = pathSvc.join(ctx.worktree, INCLUDE_FILE)
      const text = yield* rawFs.readFileString(includeFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (text === undefined) return

      const tracked = yield* trackedFiles(ctx.worktree)
      const trackedSet = new Set(tracked)

      for (const line of text.split("\n")) {
        const pattern = line.trim()
        if (!pattern || pattern.startsWith("#")) continue
        const matches = yield* Effect.tryPromise({
          try: () =>
            Glob.scan(pattern, {
              cwd: ctx.worktree,
              absolute: true,
              dot: true,
              include: "file",
            }),
          catch: (error) => error,
        }).pipe(
          Effect.map((items) => items),
          Effect.catch(() => Effect.succeed([] as string[])),
        )
        for (const absolute of matches) {
          const relative = pathSvc.relative(ctx.worktree, absolute)
          if (!relative || relative.startsWith("..") || pathSvc.isAbsolute(relative)) continue
          // Only carry files the checkout cannot already provide: tracked
          // files land in the new worktree through `git reset --hard`.
          if (trackedSet.has(relative)) continue
          yield* copyIntoWorktree(ctx.worktree, target, relative).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to carry included file", {
                file: relative,
                message: errorMessage(error),
              }),
            ),
          )
        }
      }
    })

    const trackedFiles = Effect.fnUntraced(function* (worktree: string) {
      const result = yield* git(["ls-files", "--full-name", "-z"], { cwd: worktree })
      if (result.code !== 0) return []
      return result.text.split("\0").filter(Boolean)
    })

    const copyIntoWorktree = Effect.fnUntraced(function* (source: string, target: string, relative: string) {
      const from = pathSvc.join(source, relative)
      const to = pathSvc.join(target, relative)
      const isFile = yield* fs.isFile(from).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!isFile) return
      yield* rawFs.makeDirectory(pathSvc.dirname(to), { recursive: true })
      yield* rawFs.copy(from, to, { overwrite: true })
    })

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      const info = yield* makeWorktreeInfo({ name: input?.name })
      yield* createFromInfo(info, input?.startCommand)
      return info
    })

    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)))
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
          if (!line) return acc
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() })
            return acc
          }
          const current = acc[acc.length - 1]
          if (!current) return acc
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim()
          }
          return acc
        }, [])
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        const key = yield* canonical(item.path)
        if (key === directory) return item
      }
      return undefined
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return []
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }

      const primary = yield* canonical(ctx.project.worktree)
      const primaryName = pathSvc.basename(primary).toLowerCase()
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    function stopFsmonitor(target: string) {
      return fs.exists(target).pipe(
        Effect.orDie,
        Effect.flatMap((exists) => (exists ? git(["fsmonitor--daemon", "stop"], { cwd: target }) : Effect.void)),
      )
    }

    function cleanDirectory(target: string) {
      return Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          const attempts = process.platform === "win32" ? 50 : 5
          for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
            try {
              await fsp.rm(target, { recursive: true, force: true })
              return
            } catch (error) {
              if (attempt === attempts - 1) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        },
        catch: (error) =>
          new RemoveFailedError({ message: errorMessage(error) || "Failed to remove git worktree directory" }),
      })
    }

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)

      // Never remove the worktree this instance runs in: the running-guard in
      // retention is best-effort, and removing the main worktree would
      // dispose the executing instance before git rejects the request.
      if (directory === (yield* canonical(ctx.worktree))) {
        return yield* new RemoveFailedError({ message: "Cannot remove the currently active worktree" })
      }

      // Preserve the loaded path casing for the store cache; `directory` is lowercased on Windows.
      if (directory !== (yield* canonical(ctx.worktree))) yield* store.disposeDirectory(input.directory)

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new RemoveFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entries = parseWorktreeList(list.text)
      const entry = yield* locateWorktree(entries, directory)

      if (!entry?.path) {
        const directoryExists = yield* fs.exists(directory).pipe(Effect.orDie)
        if (directoryExists) {
          yield* stopFsmonitor(directory)
          yield* cleanDirectory(directory)
        }
        return true
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path)
      yield* stopFsmonitor(entry.path)
      const removed = yield* git(["worktree", "remove", "--force", entry.path], { cwd: ctx.worktree })
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
        if (next.code !== 0) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove git worktree",
          })
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory)
        if (stale?.path) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || "Failed to remove git worktree",
          })
        }
      }

      yield* cleanDirectory(entry.path)

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) {
        const deleted = yield* git(["branch", "-D", branch], { cwd: ctx.worktree })
        if (deleted.code !== 0) {
          return yield* new RemoveFailedError({
            message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
          })
        }
      }

      return true
    })

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts)
      if (result.code !== 0) return yield* error(result)
      return result
    })

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args as string[], { cwd: directory, extendEnv: true, stdin: "ignore" }),
        )
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") }
      },
      Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
    )

    const runStartScript = Effect.fnUntraced(function* (directory: string, cmd: string, kind: string) {
      const text = cmd.trim()
      if (!text) return true
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return true
      yield* Effect.logError("worktree start command failed", { kind, directory, message: result.stderr })
      return false
    })

    const runStartScripts = Effect.fnUntraced(function* (
      directory: string,
      input: { projectID: ProjectV2.ID; extra?: string },
    ) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.projectID))
        .get()
        .pipe(Effect.orDie)
      const project = row ? Project.fromRow(row) : undefined
      const startup = project?.commands?.start?.trim() ?? ""
      const ok = yield* runStartScript(directory, startup, "project")
      if (!ok) return false
      yield* runStartScript(directory, input.extra ?? "", "worktree")
      return true
    })

    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      const base = yield* canonical(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(pathSvc.resolve(root, entry))
            if (target === base) return
            if (!target.startsWith(`${base}${pathSvc.sep}`)) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      )
    })

    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], { cwd: root })
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries)
      return yield* git(["clean", "-ffdx"], { cwd: root })
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)
      const primary = yield* canonical(ctx.worktree)
      if (directory === primary) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new ResetFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory)
      if (!entry?.path) {
        return yield* new ResetFailedError({ message: "Worktree not found" })
      }

      const worktreePath = entry.path

      const base = yield* gitSvc.defaultBranch(ctx.worktree)
      if (!base) {
        return yield* new ResetFailedError({ message: "Default branch not found" })
      }

      const sep = base.ref.indexOf("/")
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep)
        const branch = base.ref.slice(sep + 1)
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: ctx.worktree },
          (r) => new ResetFailedError({ message: r.stderr || r.text || `Failed to fetch ${base.ref}` }),
        )
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset worktree to target" }),
      )

      const cleanResult = yield* sweep(worktreePath)
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({
          message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree",
        })
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
      )

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath })
      if (status.code !== 0) {
        return yield* new ResetFailedError({ message: status.stderr || status.text || "Failed to read git status" })
      }

      if (status.text.trim()) {
        return yield* new ResetFailedError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })
      }

      yield* runStartScripts(worktreePath, { projectID: ctx.project.id }).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree start task failed", { cause })),
        Effect.forkIn(scope),
      )

      return true
    })

    const loadedDirectoryKeys = Effect.fnUntraced(function* () {
      const loaded = yield* store
        .loadedDirectories()
        .pipe(Effect.catch(() => Effect.succeed(new Set<string>() as ReadonlySet<string>)))
      return new Set(
        yield* Effect.forEach([...loaded], (directory) => canonical(directory), { concurrency: "unbounded" }),
      )
    })

    // Retention removal never forces: a worktree with uncommitted or untracked
    // changes, or whose branch holds commits that no other branch,
    // remote-tracking ref or tag reaches (so its upstream/base has not merged
    // them), is kept so automatic cleanup cannot lose work.
    const retireDirectory = Effect.fnUntraced(function* (directory: string, branch: string) {
      const ctx = yield* InstanceState.context
      if (!branch) return false
      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: directory })
      if (status.code !== 0 || status.text.trim()) return false
      const unique = yield* git(
        ["rev-list", "--count", `refs/heads/${branch}`, "--not", `--exclude=${branch}`, "--branches", "--remotes", "--tags"],
        { cwd: ctx.worktree },
      )
      if (unique.code !== 0 || unique.text.trim() !== "0") return false
      yield* store.disposeDirectory(directory)
      yield* stopFsmonitor(directory)
      // No --force: git itself refuses a worktree that became dirty since the check.
      const removed = yield* git(["worktree", "remove", directory], { cwd: ctx.worktree })
      if (removed.code !== 0) return false
      // Every commit on the branch is reachable from another ref (checked
      // above), so dropping the branch name cannot lose history.
      yield* git(["branch", "-D", branch], { cwd: ctx.worktree })
      return true
    })

    // Enrich a retention entry with session binding: a worktree marked
    // `disposable` in any bound session's metadata gets the newest bound
    // session's update time as recency instead of the directory mtime, so a
    // freshly created worktree backing a stale session no longer looks
    // recently used.
    const retentionEntry = Effect.fnUntraced(function* (input: {
      entry: Info
      updated: number
      open: boolean
      running: boolean
    }) {
      const peers = yield* boundSessions(sessionSvc, input.entry.directory).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree retention session scan failed", {
            directory: input.entry.directory,
            cause,
          }).pipe(Effect.as([] as Session.GlobalInfo[])),
        ),
      )
      const disposable = peers.some((peer) => peer.metadata?.["disposable"] === true)
      const lastUsedAt = peers.length > 0 ? Math.max(...peers.map((peer) => peer.time.updated)) : undefined
      return {
        directory: input.entry.directory,
        updated: input.updated,
        open: input.open,
        running: input.running,
        ...(disposable ? { disposable: true } : {}),
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      }
    })

    const retire = Effect.fn("Worktree.retire")(function* (input?: { opened?: string }) {
      const ctx = yield* InstanceState.context
      const wt = ConfigWorktree.settings(yield* configSvc.get())
      // Canonicalize once: canonical() lowercases on Windows while
      // InstanceStore keys keep original casing, so a raw string comparison
      // could miss a running worktree there. list() already returns
      // canonical directories.
      const self = yield* canonical(ctx.worktree)
      const root = yield* canonical(
        pathSvc.isAbsolute(wt.location) ? wt.location : pathSvc.join(ctx.worktree, wt.location),
      )
      // Only worktrees Flynncode created are eligible for retention: they live
      // under the configured location and sit on a prefixed branch. Worktrees
      // the user made by hand are never considered.
      const owned = (yield* list().pipe(Effect.catch(() => Effect.succeed([] as Info[])))).filter(
        (entry) =>
          entry.directory.startsWith(`${root}${pathSvc.sep}`) && !!entry.branch?.startsWith(`${wt.branchPrefix}/`),
      )
      const loadedKeys = yield* loadedDirectoryKeys()
      const updated = yield* Effect.forEach(
        owned,
        (entry) =>
          rawFs.stat(entry.directory).pipe(
            Effect.map((stat) => Option.getOrUndefined(stat.mtime)?.getTime() ?? 0),
            Effect.catch(() => Effect.succeed(0)),
          ),
        { concurrency: "unbounded" },
      )
      const drop = new Set(
        worktreesToRemove(
          yield* Effect.forEach(
            owned,
            (entry, index) =>
              retentionEntry({
                entry,
                updated: updated[index] ?? 0,
                open: entry.directory === self || entry.directory === input?.opened,
                running: loadedKeys.has(entry.directory),
              }),
            { concurrency: "unbounded" },
          ),
          wt.keep,
        ),
      )
      for (const entry of owned.filter((item) => drop.has(item.directory))) {
        // Re-check at removal time: a session may have loaded this worktree
        // between the snapshot and now (TOCTOU). Never remove our own or a
        // newly-running worktree.
        if (entry.directory === self) continue
        if ((yield* loadedDirectoryKeys()).has(entry.directory)) continue
        yield* retireDirectory(entry.directory, entry.branch ?? "").pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("worktree retention skipped", { directory: entry.directory, cause }),
          ),
        )
      }
    })

    const createAndRetain = Effect.fn("Worktree.createAndRetain")(function* (input?: CreateInput) {
      const info = yield* create(input)
      const opened = yield* canonical(info.directory)
      yield* retire({ opened })
      return info
    })

    // Disposable worktrees back a single session (chat or isolated subagent).
    // The branch lands under the configured prefix as
    // `<prefix>/session-<sessionID slug>` unless an explicit name is given.
    const createDisposable = Effect.fn("Worktree.createDisposable")(function* (input: {
      sessionID: string
      name?: string
    }) {
      const name = input.name ? slugify(input.name) : `session-${slugify(input.sessionID)}`
      const info = yield* makeWorktreeInfo({ name })
      yield* createFromInfo(info)
      return info
    })

    // Remove a disposable worktree only when no loaded instance runs in it.
    // Returns true when removed, false when still running or active.
    const disposeIfIdle = Effect.fn("Worktree.disposeIfIdle")(function* (input: { directory: string }) {
      const ctx = yield* InstanceState.context
      const directory = yield* canonical(input.directory)
      if (directory === (yield* canonical(ctx.worktree))) return false
      const loaded = yield* store
        .loadedDirectories()
        .pipe(Effect.catch(() => Effect.succeed(new Set<string>() as ReadonlySet<string>)))
      const loadedKeys = new Set(
        yield* Effect.forEach([...loaded], (entry) => canonical(entry), { concurrency: "unbounded" }),
      )
      if (loadedKeys.has(directory)) return false
      yield* remove({ directory })
      return true
    })

    // Hand off a session between two existing worktrees. `from` must be a
    // known worktree of this project, `to` must exist on disk, and the paths
    // must differ. Session row rebinding happens at the HTTP handler
    // boundary, which owns the schema/service dependency split.
    const handoff = Effect.fn("Worktree.handoff")(function* (input: HandoffInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const source = yield* canonical(input.from)
      const target = yield* canonical(input.to)
      if (source === target) {
        return yield* new HandoffFailedError({ message: "Cannot hand off a worktree to itself" })
      }

      const exists = yield* fs.exists(target).pipe(Effect.orDie)
      if (!exists) {
        return yield* new HandoffFailedError({ message: "Destination worktree does not exist" })
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }

      const primary = yield* canonical(ctx.worktree)
      const entry = yield* locateWorktree(parseWorktreeList(result.text), source)
      if (source !== primary && !entry?.path) {
        return yield* new HandoffFailedError({ message: "Source worktree not found" })
      }

      // Carry uncommitted source state to the destination: enumerate the
      // dirty paths and copy each one over (cp -r semantics), keeping files
      // the destination already has in its checked-out tree.
      const status = yield* git(
        ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"],
        { cwd: entry?.path ?? input.from },
      )
      if (status.code !== 0) {
        return yield* new HandoffFailedError({
          message: status.stderr || status.text || "Failed to read source worktree status",
        })
      }
      const dirty = parseStatusZ(status.text).filter((item) => !item.deleted)
      yield* Effect.forEach(
        dirty,
        (item) =>
          Effect.gen(function* () {
            const fromPath = pathSvc.join(source, item.path)
            const toPath = pathSvc.join(target, item.path)
            yield* fs.makeDirectory(pathSvc.dirname(toPath), { recursive: true }).pipe(
              Effect.mapError((error) => new HandoffFailedError({ message: errorMessage(error) })),
            )
            yield* rawFs.copy(fromPath, toPath, { overwrite: true }).pipe(
              Effect.mapError((error) => new HandoffFailedError({ message: errorMessage(error) })),
            )
          }),
        { concurrency: "unbounded", discard: true },
      )

      yield* project.addSandbox(ctx.project.id, input.to).pipe(Effect.catch(() => Effect.void))
      return true
    })

    return Service.of({
      makeWorktreeInfo,
      createFromInfo,
      create: createAndRetain,
      createDisposable,
      disposeIfIdle,
      list,
      remove,
      reset,
      handoff,
      // Service-level sweep: no just-created worktree to protect, so the
      // instance's own worktree is the only open entry.
      retire: retire(),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    FSUtil.node,
    filesystem,
    path,
    AppProcess.node,
    Git.node,
    Project.node,
    InstanceStore.node,
    Database.node,
    Config.node,
    Session.node,
  ],
})

export * as Worktree from "."
