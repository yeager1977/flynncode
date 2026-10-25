import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Flag } from "@flynncode/core/flag/flag"
import { AppProcess } from "@flynncode/core/process"
import { sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Layer, Schedule, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { lstat, readdir, realpath, rm } from "node:fs/promises"
import path from "path"
import { Project } from "@/project/project"
import { JanitorInspect } from "./inspect"
import { JanitorJunk } from "./junk"

export const IDLE_MS = 3 * 24 * 60 * 60 * 1000
const HISTORY_MS = 7 * 24 * 60 * 60 * 1000
const ROOTS = [".worktrees", path.join(".opencode", "worktrees")]

export type ReviewItem = {
  path: string
  project: string
  repo?: string
  branch?: string
  bytes: number
  capped: boolean
  lastActivity: number
  reason: "dirty" | "unpushed" | "scratch" | "recent" | "error"
  detail?: string
}

export type CleanedItem = { path: string; bytes: number; time: number; kind: "worktree" | "junk" }

export type Report = { items: ReviewItem[]; cleaned: CleanedItem[]; scanning: boolean; lastScan?: number }

export type RemoveResult = { path: string; ok: boolean; error?: string }

export interface Interface {
  readonly scan: () => Effect.Effect<Report>
  readonly report: () => Effect.Effect<Report>
  readonly remove: (paths: string[]) => Effect.Effect<RemoveResult[]>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/WorktreeJanitor") {}

// A delete target: a direct child of a project's cleanup root (`rooted`) and/or a
// linked worktree git lists for the project (`listed`). Paths are realpath-resolved.
type Target = { path: string; project: string; rooted: boolean; listed: boolean }

type Found = { path: string; lastActivity: number; repo?: string; branch?: string }

// Worktrees are auto-removed only when idle, clean and merged/pushed, and never
// with --force. Anything uncertain (inspection errors, dirty or unpushed work,
// scratch folders, recent use) goes to the review list for the owner to decide.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const database = yield* Database.Service
    const proc = yield* AppProcess.Service
    const lock = yield* Semaphore.make(1)
    const sizes = new Map<string, { lastActivity: number; bytes: number; capped: boolean }>()
    const state: Report = { items: [], cleaned: [], scanning: false }

    const snapshot = () => ({ ...state, items: [...state.items], cleaned: [...state.cleaned] })

    const runScan = Effect.fn("WorktreeJanitor.scan")(function* () {
      state.scanning = true
      const now = Date.now()
      const targets = yield* discover()
      const busy = yield* activeDirectories(now)
      const cleaned: CleanedItem[] = []
      const items = (yield* Effect.forEach(targets, (target) =>
        visit(target, { now, busy, cleaned }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("worktree janitor could not check", {
              path: target.path,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(failed(target, cause))),
          ),
        ),
      )).filter((item) => item !== undefined)
      state.items = items
      state.cleaned = [...state.cleaned, ...cleaned].filter((entry) => entry.time >= now - HISTORY_MS)
      state.lastScan = now
      state.scanning = false
      yield* Effect.logInfo("worktree janitor scan", {
        candidates: targets.length,
        removed: cleaned.filter((entry) => entry.kind === "worktree").length,
        junkBytes: cleaned.filter((entry) => entry.kind === "junk").reduce((sum, entry) => sum + entry.bytes, 0),
        review: items.length,
      })
      return snapshot()
    })

    const visit = Effect.fnUntraced(function* (
      target: Target,
      input: { now: number; busy: (dir: string) => boolean; cleaned: CleanedItem[] },
    ) {
      const first = yield* JanitorInspect.inspect(target.path)
      if (first.kind === "main") return undefined
      if (first.kind === "scratch") {
        // Only folders in a cleanup root count as scratch; a git-listed worktree
        // without a .git file is broken, not disposable.
        if (!target.rooted) return yield* Effect.fail(new Error("git lists this worktree but it has no .git file"))
        return yield* review(target, first, "scratch")
      }
      if (input.busy(first.path) || input.now - first.lastActivity < IDLE_MS)
        return yield* review(target, first, "recent")

      const tracked = yield* trackedFiles(first.path)
      // A junk-named directory that git tracks (or that holds tracked files) is
      // project content, not junk.
      const junk = yield* Effect.promise(() =>
        JanitorJunk.removeJunk(first.path, {
          skip: (dir) => tracked.some((file) => file === dir || file.startsWith(dir + path.sep)),
        }),
      )
      input.cleaned.push(
        ...junk.items.map((entry) => ({
          path: entry.path,
          bytes: entry.bytes,
          time: Date.now(),
          kind: "junk" as const,
        })),
      )

      const second = yield* JanitorInspect.inspect(first.path)
      if (second.kind !== "worktree") return yield* Effect.fail(new Error("changed during the scan"))
      if (!second.safe) {
        if (second.dirty > 0) return yield* review(target, second, "dirty", `${second.dirty} changed files`)
        return yield* review(target, second, "unpushed", `${second.unpushed} unpushed commits`)
      }
      const bytes = (yield* Effect.promise(() => JanitorJunk.size(second.path))).bytes
      yield* gitChecked(second.repo, ["worktree", "remove", second.path])
      yield* JanitorInspect.git(second.repo, ["worktree", "prune"])
      sizes.delete(second.path)
      input.cleaned.push({ path: second.path, bytes, time: Date.now(), kind: "worktree" })
      return undefined
    })

    const review = Effect.fnUntraced(function* (
      target: Target,
      found: Found,
      reason: ReviewItem["reason"],
      detail?: string,
    ) {
      const measured = yield* measure(found.path, found.lastActivity)
      return {
        path: found.path,
        project: target.project,
        repo: found.repo,
        branch: found.branch,
        bytes: measured.bytes,
        capped: measured.capped,
        lastActivity: found.lastActivity,
        reason,
        detail,
      } satisfies ReviewItem
    })

    const failed = Effect.fnUntraced(function* (target: Target, cause: Cause.Cause<unknown>) {
      const lastActivity = yield* Effect.promise(() =>
        lstat(target.path).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      )
      const error = Cause.squash(cause)
      return yield* review(target, { path: target.path, lastActivity }, "error", errorMessage(error)).pipe(
        Effect.catchCause(() =>
          Effect.succeed({
            path: target.path,
            project: target.project,
            bytes: 0,
            capped: false,
            lastActivity,
            reason: "error" as const,
            detail: errorMessage(error),
          }),
        ),
      )
    })

    const measure = Effect.fnUntraced(function* (dir: string, lastActivity: number) {
      const cached = sizes.get(dir)
      if (cached && cached.lastActivity === lastActivity) return cached
      const measured = yield* Effect.promise(() => JanitorJunk.size(dir))
      sizes.set(dir, { lastActivity, ...measured })
      return measured
    })

    const discover = Effect.fnUntraced(function* () {
      const roots = yield* projectRoots()
      const seen = new Set<string>()
      return (yield* Effect.forEach(roots, (root) => projectTargets(root, roots))).flat().filter((target) => {
        if (seen.has(target.path)) return false
        seen.add(target.path)
        return true
      })
    })

    const projectRoots = Effect.fnUntraced(function* () {
      const projects = yield* project.list()
      const resolved = yield* Effect.promise(() =>
        Promise.all(projects.map((entry) => realpath(entry.worktree).catch(() => undefined))),
      )
      return [...new Set(resolved.filter((root): root is string => root !== undefined))]
    })

    // Everything the janitor may touch for one project. Used both to discover
    // candidates and to re-check a manual removal right before it happens.
    const projectTargets = Effect.fnUntraced(function* (root: string, roots: string[]) {
      const rooted = yield* Effect.promise(() => rootChildren(root))
      const listed = yield* listedWorktrees(root)
      const all = [...new Set([...rooted, ...listed])]
      return all
        .filter((dir) => !roots.some((other) => other === dir || other.startsWith(dir + path.sep)))
        .map((dir) => ({ path: dir, project: root, rooted: rooted.includes(dir), listed: listed.includes(dir) }))
    })

    const listedWorktrees = Effect.fnUntraced(function* (root: string) {
      const result = yield* JanitorInspect.git(root, ["worktree", "list", "--porcelain"])
      if (result.code !== 0) return []
      // The first entry is always the main worktree; bare entries are repositories.
      const paths = result.text
        .split(/\n\n+/)
        .slice(1)
        .map((block) => block.split("\n"))
        .filter((lines) => !lines.includes("bare"))
        .flatMap((lines) => lines.filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)))
      const resolved = yield* Effect.promise(() =>
        Promise.all(paths.map((dir) => realpath(dir).catch(() => undefined))),
      )
      return resolved.filter((dir): dir is string => dir !== undefined && dir !== root)
    })

    const trackedFiles = Effect.fnUntraced(function* (dir: string) {
      const result = yield* JanitorInspect.git(dir, ["ls-files", "-z"])
      if (result.code !== 0) return yield* Effect.fail(new Error(`git ls-files in ${dir} failed`))
      return result.text
        .split("\0")
        .filter(Boolean)
        .map((file) => path.join(dir, file))
    })

    const activeDirectories = Effect.fnUntraced(function* (now: number) {
      const since = now - IDLE_MS
      const rows = yield* database.db
        .all<{ directory: string }>(
          sql`SELECT directory FROM session s WHERE s.time_updated >= ${since}
              OR EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.time_updated >= ${since})
              OR EXISTS (SELECT 1 FROM part p WHERE p.session_id = s.id AND p.time_updated >= ${since})`,
        )
        .pipe(Effect.orDie)
      const raw = rows.map((row) => row.directory).filter(Boolean)
      const resolved = yield* Effect.promise(() => Promise.all(raw.map((dir) => realpath(dir).catch(() => dir))))
      const dirs = [...new Set([...raw, ...resolved])]
      return (candidate: string) => dirs.some((dir) => dir === candidate || dir.startsWith(candidate + path.sep))
    })

    const gitChecked = Effect.fnUntraced(function* (cwd: string, args: string[]) {
      const result = yield* proc.run(ChildProcess.make("git", args, { cwd, extendEnv: true, stdin: "ignore" }))
      if (result.exitCode !== 0)
        return yield* Effect.fail(
          new Error(result.stderr.toString("utf8").trim() || `git ${args.join(" ")} exited ${result.exitCode}`),
        )
    })

    const removeOne = Effect.fnUntraced(function* (input: string) {
      const resolved = yield* Effect.promise(() => realpath(input).catch(() => input))
      const listed = state.items.find((item) => item.path === resolved)
      if (!listed) return { path: input, ok: false, error: "not on the cleanup review list" }
      const target = (yield* projectTargets(listed.project, yield* projectRoots())).find(
        (entry) => entry.path === resolved,
      )
      if (!target) return yield* Effect.fail(new Error("no longer inside a cleanup root of its project"))
      const found = yield* JanitorInspect.inspect(resolved)
      if (found.kind === "main") return yield* Effect.fail(new Error("is a main checkout"))
      if (found.kind === "scratch" && !target.rooted)
        return yield* Effect.fail(new Error("git lists this worktree but it has no .git file"))
      if (found.kind === "scratch") yield* Effect.promise(() => rm(resolved, { recursive: true, force: true }))
      if (found.kind === "worktree") {
        // The owner chose this item from the review list, so local changes go too;
        // the branch and its commits are kept.
        yield* gitChecked(found.repo, ["worktree", "remove", "--force", resolved])
        yield* JanitorInspect.git(found.repo, ["worktree", "prune"])
      }
      state.items = state.items.filter((item) => item.path !== resolved)
      state.cleaned.push({ path: resolved, bytes: listed.bytes, time: Date.now(), kind: "worktree" })
      sizes.delete(resolved)
      return { path: input, ok: true }
    })

    const scan = () =>
      lock.withPermit(
        runScan().pipe(
          Effect.ensuring(
            Effect.sync(() => {
              state.scanning = false
            }),
          ),
          Effect.provideService(AppProcess.Service, proc),
        ),
      )

    const remove = (paths: string[]) =>
      lock.withPermit(
        Effect.forEach(paths, (input) =>
          removeOne(input).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({ path: input, ok: false, error: errorMessage(Cause.squash(cause)) }),
            ),
          ),
        ).pipe(Effect.provideService(AppProcess.Service, proc)),
      )

    const report = () => Effect.sync(snapshot)

    if (!Flag.OPENCODE_DISABLE_WORKTREE_CLEANUP)
      yield* scan().pipe(
        Effect.catchCause((cause) => Effect.logError("worktree janitor scan failed", { cause: Cause.pretty(cause) })),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
        Effect.delay(Duration.minutes(2)),
        Effect.forkScoped,
      )
    return Service.of({ scan, report, remove })
  }),
)

async function rootChildren(root: string) {
  const found = await Promise.all(
    ROOTS.map(async (name) => {
      const dir = await realpath(path.join(root, name)).catch(() => undefined)
      if (!dir) return []
      // Dirent never follows symlinks, so linked children are skipped.
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name))
    }),
  )
  return found.flat()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export const node = LayerNode.make({ service: Service, layer, deps: [Project.node, Database.node, AppProcess.node] })

export * as WorktreeJanitor from "./janitor"
