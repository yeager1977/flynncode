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
// .git), `error`, and `recent` for anything in active use or kept without risk
// (outside the cleanup folders, or on the default/long-lived branch). Every
// worktree item says what a manual (forced) remove would lose: `dirty` changed
// paths, `unpushed` commits and `ignored` non-regenerable local files, all also
// summed up in `detail`. Items whose inspection failed carry none of these.
export type ReviewItem = {
  path: string
  project: string
  repo?: string
  branch?: string
  head?: string
  detached?: boolean
  dirty?: number
  unpushed?: number
  ignored?: number
  ignoredExample?: string
  bytes: number
  capped: boolean
  lastActivity: number
  reason: "dirty" | "unpushed" | "scratch" | "recent" | "error"
  detail?: string
}

// `rescued` names the branch a manual remove created to keep a detached HEAD's
// unpushed commits reachable.
export type CleanedItem = {
  path: string
  bytes: number
  time: number
  kind: "worktree" | "junk" | "scratch"
  rescued?: string
}

export type Report = { items: ReviewItem[]; cleaned: CleanedItem[]; scanning: boolean; lastScan?: number }

export type RemoveResult = { path: string; ok: boolean; error?: string; rescued?: string }

export interface Interface {
  readonly scan: () => Effect.Effect<Report>
  readonly report: () => Effect.Effect<Report>
  readonly remove: (paths: string[]) => Effect.Effect<RemoveResult[]>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/WorktreeJanitor") {}

// A delete target: a direct child of a project's cleanup root (`rooted`) and/or a
// linked worktree git lists for the project (`listed`). Paths are realpath-resolved.
type Target = { path: string; project: string; rooted: boolean; listed: boolean }

type Worktree = Extract<JanitorInspect.Inspection, { kind: "worktree" }>

type Scratch = Extract<JanitorInspect.Inspection, { kind: "scratch" }>

// A worktree inspection plus its non-regenerable ignored files.
type Seen = Worktree & { ignored: string[] }

// The scanned state a manual remove must find unchanged; missing when the
// inspection failed, which makes the item unremovable from the list.
type Listed = ReviewItem & { fingerprint?: string }

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
    const state: Omit<Report, "items"> & { items: Listed[] } = { items: [], cleaned: [], scanning: false }

    const snapshot = (): Report => ({
      ...state,
      items: state.items.map(({ fingerprint, ...item }) => item),
      cleaned: [...state.cleaned],
    })

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
      if (input.busy(first.path) || input.now - first.lastActivity < IDLE_MS)
        return held(target, yield* settle(first), { recent: true })
      // Worktrees git lists elsewhere on disk (a parked dev checkout, Flynncode
      // sandboxes) are only ever reported, never cleaned automatically.
      if (!target.rooted)
        return held(target, yield* settle(first), { why: "outside cleanup folders — remove manually" })

      const tracked = yield* trackedFiles(first.path)
      const keep = yield* keptJunk(first.path, tracked)
      const junk = yield* Effect.promise(() => JanitorJunk.removeJunk(first.path, { skip: (dir) => keep.has(dir) }))
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
      // git status hides ignored files and `git worktree remove` deletes them, so
      // anything ignored that tooling cannot rebuild (.env, local config) keeps it.
      const seen = yield* settle(second)
      const base = (yield* JanitorInspect.defaultBranch(seen.repo))?.replace(/^origin\//, "")
      const branch = seen.branch
      if (branch && (branch === base || LONG_LIVED.has(branch)))
        return held(target, seen, { why: `checks out ${branch} — remove manually` })
      if (!seen.safe || seen.ignored.length > 0) return held(target, seen, {})

      const bytes = (yield* measure(seen.path, seen.lastActivity)).bytes
      const failure = yield* gitChecked(seen.repo, ["worktree", "remove", seen.path]).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
      if (failure) {
        yield* Effect.logWarning("worktree janitor could not remove", { path: seen.path, error: failure })
        return review(target, seen, "error", failure)
      }
      yield* JanitorInspect.git(seen.repo, ["worktree", "prune"])
      sizes.delete(seen.path)
      input.cleaned.push({ path: seen.path, bytes, time: Date.now(), kind: "worktree" })
      return undefined
    })

    // A worktree that is not auto-removed: the reason names the biggest risk (or
    // `recent` when in use), and `detail` lists everything a forced remove would lose.
    const held = (target: Target, found: Seen, options: { recent?: boolean; why?: string }) => {
      const losses = [
        found.dirty > 0 ? `${found.dirty} changed files` : undefined,
        found.unpushed > 0 ? `${found.unpushed} unpushed commits` : undefined,
        found.ignored.length > 0 ? `${found.ignored.length} ignored local files, e.g. ${found.ignored[0]}` : undefined,
      ].filter((loss) => loss !== undefined)
      const detail = [losses.join(", "), options.why].filter(Boolean).join("; ") || undefined
      if (options.recent) return review(target, found, "recent", detail)
      if (found.dirty > 0) return review(target, found, "dirty", detail)
      if (!found.safe) return review(target, found, "unpushed", detail)
      if (found.ignored.length > 0) return review(target, found, "dirty", detail)
      return review(target, found, "recent", detail)
    }

    const settle = Effect.fnUntraced(function* (found: Worktree) {
      return { ...found, ignored: yield* ignoredLocalFiles(found.path) } satisfies Seen
    })

    // Junk the pass must keep. A junk-named directory that git tracks (or that
    // holds tracked files) is project content. `coverage` is also a common source
    // folder name, so it only counts as junk when git ignores it (kept if git fails).
    const keptJunk = Effect.fnUntraced(function* (worktree: string, tracked: string[]) {
      const candidates = yield* Effect.promise(() => JanitorJunk.findJunk(worktree))
      const kept = yield* Effect.forEach(candidates, (dir) =>
        Effect.gen(function* () {
          if (tracked.some((file) => file === dir || file.startsWith(dir + path.sep))) return dir
          if (path.basename(dir) !== "coverage") return undefined
          return (yield* JanitorInspect.git(worktree, ["check-ignore", "-q", dir])).code === 0 ? undefined : dir
        }),
      )
      return new Set(kept.filter((dir) => dir !== undefined))
    })

    const review = (target: Target, found: Seen | Scratch, reason: ReviewItem["reason"], detail?: string) => {
      const cached = fresh(found.path, found.lastActivity)
      const base = {
        path: found.path,
        project: target.project,
        bytes: cached?.bytes ?? 0,
        capped: cached?.capped ?? false,
        lastActivity: found.lastActivity,
        reason,
        detail,
        fingerprint: fingerprint(found),
      }
      if (found.kind === "scratch") return base satisfies Listed
      return {
        ...base,
        repo: found.repo,
        branch: found.branch,
        head: found.head,
        detached: found.branch === undefined,
        dirty: found.dirty,
        unpushed: found.unpushed,
        ignored: found.ignored.length,
        ignoredExample: found.ignored[0],
      } satisfies Listed
    }

    const failed = Effect.fnUntraced(function* (target: Target, cause: Cause.Cause<unknown>) {
      const lastActivity = yield* Effect.promise(() =>
        lstat(target.path).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      )
      const cached = fresh(target.path, lastActivity)
      return {
        path: target.path,
        project: target.project,
        bytes: cached?.bytes ?? 0,
        capped: cached?.capped ?? false,
        lastActivity,
        reason: "error",
        detail: errorMessage(Cause.squash(cause)),
      } satisfies Listed
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
      if (!listed.fingerprint)
        return yield* Effect.fail(new Error("this item could not be inspected; fix or remove it manually"))
      const target = (yield* projectTargets(listed.project, yield* projectRoots())).find(
        (entry) => entry.path === resolved,
      )
      if (!target) return yield* Effect.fail(new Error("no longer inside a cleanup root of its project"))
      const found = yield* JanitorInspect.inspect(resolved)
      if (found.kind === "main") return yield* Effect.fail(new Error("is a main checkout"))
      if (found.kind === "scratch" && !target.rooted)
        return yield* Effect.fail(new Error("git lists this worktree but it has no .git file"))
      const current = found.kind === "worktree" ? yield* settle(found) : found
      if (changed(listed, current)) return yield* Effect.fail(new Error("changed since the last scan; rescan first"))
      if (current.kind === "scratch") yield* Effect.promise(() => rm(resolved, { recursive: true, force: true }))
      // The owner saw everything this deletes (local changes, ignored files) on the
      // review list. A branch keeps its commits; a detached HEAD's unpushed commits
      // get a janitor/rescued-* branch first so they stay reachable.
      const rescued =
        current.kind === "worktree" && current.branch === undefined && current.unpushed > 0
          ? yield* rescue(current.repo, current.head)
          : undefined
      if (current.kind === "worktree") {
        yield* gitChecked(current.repo, ["worktree", "remove", "--force", resolved])
        yield* JanitorInspect.git(current.repo, ["worktree", "prune"])
      }
      state.items = state.items.filter((item) => item.path !== resolved)
      state.cleaned.push({ path: resolved, bytes: listed.bytes, time: Date.now(), kind: current.kind, rescued })
      sizes.delete(resolved)
      return { path: input, ok: true, rescued }
    })

    const rescue = Effect.fnUntraced(function* (repo: string, head: string) {
      const base = `janitor/rescued-${head.slice(0, 7)}`
      const taken = (yield* JanitorInspect.git(repo, [
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${base}`,
        `refs/heads/${base}-*`,
      ])).text.split("\n")
      // One more candidate than taken names, so at least one is free.
      const name = Array.from({ length: taken.length + 1 }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`)).find(
        (candidate) => !taken.includes(candidate),
      )
      if (!name) return yield* Effect.fail(new Error("no free rescue branch name"))
      yield* gitChecked(repo, ["branch", name, head])
      return name
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
// anything new: another kind, repo or branch, or a different fingerprint.
function changed(listed: Listed, found: Seen | Scratch) {
  if (found.kind !== (listed.repo ? "worktree" : "scratch")) return true
  if (found.kind === "worktree" && (found.repo !== listed.repo || found.branch !== listed.branch)) return true
  return fingerprint(found) !== listed.fingerprint
}

// A worktree's HEAD, exact `git status --porcelain` text and non-regenerable
// ignored files; a scratch folder's latest activity (its own and its direct
// children's mtimes).
function fingerprint(found: Seen | Scratch) {
  if (found.kind === "scratch") return `scratch\0${found.lastActivity}`
  return ["worktree", found.head, found.status, ...[...found.ignored].sort()].join("\0")
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
