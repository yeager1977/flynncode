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
const LONG_LIVED = new Set(["dev", "main", "master"])

// Reasons: `dirty` (changed or ignored local files), `unpushed`, `scratch` (no
// .git), `error`, and `recent` for anything kept without risk — in active use, or
// clean and safe but never auto-removed (outside the cleanup folders, or on the
// default/long-lived branch), which `detail` then explains. `repo`, `branch` and
// `dirty` record the scanned state so a manual remove can refuse a changed item.
export type ReviewItem = {
  path: string
  project: string
  repo?: string
  branch?: string
  dirty?: number
  bytes: number
  capped: boolean
  lastActivity: number
  reason: "dirty" | "unpushed" | "scratch" | "recent" | "error"
  detail?: string
}

export type CleanedItem = { path: string; bytes: number; time: number; kind: "worktree" | "junk" | "scratch" }

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

type Found = { path: string; lastActivity: number; repo?: string; branch?: string; dirty?: number }

type Checked = Exclude<JanitorInspect.Inspection, { kind: "main" }>

type Worktree = Extract<JanitorInspect.Inspection, { kind: "worktree" }>

// Worktrees are auto-removed only when idle, clean and merged/pushed, and never
// with --force. Anything uncertain (inspection errors, dirty or unpushed work,
// scratch folders, recent use) goes to the review list for the owner to decide.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const database = yield* Database.Service
    const proc = yield* AppProcess.Service
    // `lock` guards discovery and every delete (shared with remove); `single` keeps
    // one scan at a time, including its size walks, which run outside `lock` so a
    // slow first scan does not hold up a manual remove.
    const lock = yield* Semaphore.make(1)
    const single = yield* Semaphore.make(1)
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
      yield* Effect.logInfo("worktree janitor scan", {
        candidates: targets.length,
        removed: cleaned.filter((entry) => entry.kind === "worktree").length,
        junkBytes: cleaned.filter((entry) => entry.kind === "junk").reduce((sum, entry) => sum + entry.bytes, 0),
        review: items.length,
      })
    })

    const measureItems = Effect.fnUntraced(function* () {
      yield* Effect.forEach([...state.items], (item) => measure(item.path, item.lastActivity), { discard: true })
      // A remove may have dropped items while sizes were measured; only update what is left.
      state.items = state.items.map((item) => {
        const cached = fresh(item.path, item.lastActivity)
        return cached ? { ...item, bytes: cached.bytes, capped: cached.capped } : item
      })
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
        return review(target, first, "scratch")
      }
      if (input.busy(first.path) || input.now - first.lastActivity < IDLE_MS) return review(target, first, "recent")
      // Worktrees git lists elsewhere on disk (a parked dev checkout, Flynncode
      // sandboxes) are only ever reported, never cleaned automatically.
      if (!target.rooted) return held(target, first, "outside cleanup folders — remove manually")

      const tracked = yield* trackedFiles(first.path)
      const junk = yield* Effect.promise(() =>
        JanitorJunk.removeJunk(first.path, { skip: (dir) => keepJunk(first.path, dir, tracked) }),
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
      const base = (yield* JanitorInspect.defaultBranch(second.repo))?.replace(/^origin\//, "")
      const branch = second.branch
      if (branch && (branch === base || LONG_LIVED.has(branch)))
        return held(target, second, `checks out ${branch} — remove manually`)
      if (!second.safe) return held(target, second)
      // git status hides ignored files and `git worktree remove` deletes them, so
      // anything ignored that tooling cannot rebuild (.env, local config) keeps it.
      const ignored = yield* ignoredLocalFiles(second.path)
      if (ignored.length > 0)
        return review(target, second, "dirty", `${ignored.length} ignored local files, e.g. ${ignored[0]}`)

      const bytes = (yield* measure(second.path, second.lastActivity)).bytes
      const failure = yield* gitChecked(second.repo, ["worktree", "remove", second.path]).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
      if (failure) {
        yield* Effect.logWarning("worktree janitor could not remove", { path: second.path, error: failure })
        return review(target, second, "error", failure)
      }
      yield* JanitorInspect.git(second.repo, ["worktree", "prune"])
      sizes.delete(second.path)
      input.cleaned.push({ path: second.path, bytes, time: Date.now(), kind: "worktree" })
      return undefined
    })

    // A worktree that is not auto-removed: report what is at risk, else why it was kept.
    const held = (target: Target, found: Worktree, why?: string) => {
      if (found.dirty > 0) return review(target, found, "dirty", `${found.dirty} changed files`)
      if (!found.safe) return review(target, found, "unpushed", `${found.unpushed} unpushed commits`)
      return review(target, found, "recent", why)
    }

    // A junk-named directory that git tracks (or that holds tracked files) is
    // project content. `coverage` is also a common source folder name, so it only
    // counts as junk when git ignores it.
    const keepJunk = async (worktree: string, dir: string, tracked: string[]) => {
      if (tracked.some((file) => file === dir || file.startsWith(dir + path.sep))) return true
      if (path.basename(dir) !== "coverage") return false
      const result = await Effect.runPromise(
        JanitorInspect.git(worktree, ["check-ignore", "-q", dir]).pipe(Effect.provideService(AppProcess.Service, proc)),
      )
      return result.code !== 0
    }

    const review = (target: Target, found: Found, reason: ReviewItem["reason"], detail?: string) => {
      const cached = fresh(found.path, found.lastActivity)
      return {
        path: found.path,
        project: target.project,
        repo: found.repo,
        branch: found.branch,
        dirty: found.dirty,
        bytes: cached?.bytes ?? 0,
        capped: cached?.capped ?? false,
        lastActivity: found.lastActivity,
        reason,
        detail,
      } satisfies ReviewItem
    }

    const failed = Effect.fnUntraced(function* (target: Target, cause: Cause.Cause<unknown>) {
      const lastActivity = yield* Effect.promise(() =>
        lstat(target.path).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      )
      return review(target, { path: target.path, lastActivity }, "error", errorMessage(Cause.squash(cause)))
    })

    const fresh = (dir: string, lastActivity: number) => {
      const cached = sizes.get(dir)
      return cached?.lastActivity === lastActivity ? cached : undefined
    }

    const measure = Effect.fnUntraced(function* (dir: string, lastActivity: number) {
      const cached = fresh(dir, lastActivity)
      if (cached) return cached
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

    const ignoredLocalFiles = Effect.fnUntraced(function* (dir: string) {
      const result = yield* JanitorInspect.git(dir, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ])
      if (result.code !== 0) return yield* Effect.fail(new Error(`git ls-files --ignored in ${dir} failed`))
      return result.text
        .split("\0")
        .filter(Boolean)
        .filter((file) => !JanitorJunk.isRegenerable(file))
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
      if (changed(listed, found)) return yield* Effect.fail(new Error("changed since the last scan; rescan first"))
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
      state.cleaned.push({ path: resolved, bytes: listed.bytes, time: Date.now(), kind: found.kind })
      sizes.delete(resolved)
      return { path: input, ok: true }
    })

    const scan = () =>
      single.withPermit(
        lock.withPermit(runScan()).pipe(
          Effect.andThen(measureItems()),
          Effect.andThen(
            Effect.sync(() => {
              state.scanning = false
              return snapshot()
            }),
          ),
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

// The owner reviewed the item in its scanned state; a remove must not act on
// anything new (another branch or repo, more local changes, a different kind).
// Items whose inspection failed carry no scanned kind, so they need a rescan first.
function changed(listed: ReviewItem, found: Checked) {
  const scanned = listed.reason === "scratch" ? "scratch" : listed.repo ? "worktree" : undefined
  if (found.kind !== scanned) return true
  if (found.kind === "scratch") return false
  return found.repo !== listed.repo || found.branch !== listed.branch || found.dirty > (listed.dirty ?? 0)
}

async function rootChildren(root: string) {
  const found = await Promise.all(
    ROOTS.map(async (name) => {
      const dir = path.join(root, name)
      // root is already realpath-resolved, so a mismatch means the cleanup folder
      // (or .opencode) is a symlink to somewhere else; never follow it.
      if ((await realpath(dir).catch(() => undefined)) !== dir) return []
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
