import { AppProcess } from "@flynncode/core/process"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { lstat, realpath, stat } from "node:fs/promises"
import path from "path"
import { JanitorJunk } from "./junk"

export type Inspection =
  | {
      path: string
      kind: "worktree"
      repo: string
      branch?: string
      head: string
      status: string
      // Tracked files git is told to skip (assume-unchanged, skip-worktree), as
      // "path\0mtime\0size" or "path\0missing"; status never shows edits to them.
      hidden: string[]
      // Initialized submodules (paths), or the worktree's git `modules` folder when
      // one holds submodule repositories that are not checked out.
      submodules: string[]
      dirty: number
      unpushed: number
      safe: boolean
      lastActivity: number
    }
  // `capped`: the walk ran out of time or hit an unreadable folder, so a newer
  // file (or a nested repo) may be missing. `nested`: folders holding a .git entry.
  | { path: string; kind: "scratch"; lastActivity: number; capped: boolean; nested: string[] }
  | { path: string; kind: "main" }

// GIT_OPTIONAL_LOCKS=0 keeps `git status` from refreshing the index, so the
// hourly scan never takes index.lock in a worktree an agent is using (or bumps
// the index mtime that the idle check reads).
export const gitEnv = { GIT_OPTIONAL_LOCKS: "0" }

export const git = Effect.fnUntraced(function* (cwd: string, args: string[]) {
  const proc = yield* AppProcess.Service
  return yield* proc.run(ChildProcess.make("git", args, { cwd, env: gitEnv, extendEnv: true, stdin: "ignore" })).pipe(
    Effect.map((result) => ({ code: result.exitCode, text: result.stdout.toString("utf8").trim() })),
    Effect.catchCause(() => Effect.succeed({ code: 1, text: "" })),
  )
})

export const defaultBranch = Effect.fnUntraced(function* (repo: string) {
  const origin = yield* git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  // A dangling origin/HEAD (target ref missing) must not be trusted as the base.
  if (
    origin.code === 0 &&
    origin.text &&
    (yield* git(repo, ["rev-parse", "--verify", "--quiet", origin.text])).code === 0
  )
    return origin.text
  for (const name of ["dev", "main", "master"]) {
    const local = yield* git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])
    if (local.code === 0) return name
    const remote = yield* git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])
    if (remote.code === 0) return `origin/${name}`
  }
  return undefined
})

export const inspect = Effect.fn("JanitorInspect.inspect")(function* (target: string) {
  const dir = yield* Effect.tryPromise({
    try: () => realpath(target),
    catch: (cause) => new Error(`cannot resolve ${target}: ${String(cause)}`),
  })
  const dotGit = yield* Effect.tryPromise({
    try: () =>
      lstat(path.join(dir, ".git")).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return undefined
        throw cause
      }),
    catch: (cause) => new Error(`cannot inspect ${dir}/.git: ${String(cause)}`),
  })
  if (!dotGit) {
    const walk = yield* Effect.promise(() => JanitorJunk.size(dir))
    return { path: dir, kind: "scratch" as const, lastActivity: walk.mtime, capped: walk.capped, nested: walk.repos }
  }
  if (dotGit.isDirectory()) return { path: dir, kind: "main" as const }
  if (dotGit.isSymbolicLink()) {
    const resolved = yield* Effect.promise(() => stat(path.join(dir, ".git")).catch(() => undefined))
    if (resolved?.isDirectory()) return { path: dir, kind: "main" as const }
  }

  // A worktree's .git file points into <repo>/.git/worktrees/<name>; the owning
  // repo is the common dir's parent, which also covers nested repos whose
  // worktrees live in a parent project's .worktrees/.
  const common = yield* git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const gitdir = yield* git(dir, ["rev-parse", "--absolute-git-dir"])
  if (common.code !== 0 || gitdir.code !== 0) return yield* Effect.fail(new Error(`not a git worktree: ${dir}`))
  // A .git file can also belong to a main checkout (git init --separate-git-dir).
  if (common.text === gitdir.text) return { path: dir, kind: "main" as const }
  const repo = path.dirname(common.text)
  const branch = (yield* git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).text || undefined
  const head = yield* requireOk(yield* git(dir, ["rev-parse", "HEAD"]), `git rev-parse in ${dir}`)
  // Every untracked file is listed on its own, whatever the user's status config,
  // so the count is real and a file added inside an untracked folder changes it.
  const status = yield* requireOk(
    yield* git(dir, [
      "-c",
      "status.showUntrackedFiles=all",
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
    `git status in ${dir}`,
  )
  const flagged = (yield* requireOk(yield* git(dir, ["ls-files", "-v", "-z"]), `git ls-files -v in ${dir}`))
    .split("\0")
    // A lowercase tag marks assume-unchanged, `S` skip-worktree.
    .filter((entry) => /^([a-z]|S) /.test(entry))
  const skipped = yield* Effect.promise(() =>
    Promise.all(
      flagged.map((entry) =>
        lstat(path.join(dir, entry.slice(2))).then(
          (info) => ({ key: `${entry.slice(2)}\0${info.mtimeMs}\0${info.size}`, counts: true }),
          (cause: NodeJS.ErrnoException) => ({
            key: `${entry.slice(2)}\0missing`,
            // A sparse checkout leaves files outside its cone out of the folder as
            // skip-worktree entries; their content is in HEAD, so nothing is lost.
            counts: !(entry.startsWith("S ") && (cause.code === "ENOENT" || cause.code === "ENOTDIR")),
          }),
        ),
      ),
    ),
  )
  const hidden = skipped.map((entry) => entry.key)
  const dirty = (status ? status.split("\n").length : 0) + skipped.filter((entry) => entry.counts).length
  const submodules = yield* initializedSubmodules(dir, gitdir.text)
  const base = yield* defaultBranch(repo)
  const unpushed = Number(
    yield* requireOk(
      yield* git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes", ...(base ? [base] : [])]),
      `git rev-list in ${dir}`,
    ),
  )
  if (!Number.isInteger(unpushed)) return yield* Effect.fail(new Error(`unreadable unpushed count in ${dir}`))
  const merged = base ? (yield* git(dir, ["merge-base", "--is-ancestor", "HEAD", base])).code === 0 : false
  const upstream = yield* git(dir, ["rev-list", "--count", "@{u}..HEAD"])
  const pushed =
    (upstream.code === 0 && upstream.text === "0") ||
    (yield* git(dir, ["branch", "-r", "--contains", "HEAD"])).text !== ""
  const committed = Number(yield* requireOk(yield* git(dir, ["log", "-1", "--format=%ct"]), `git log in ${dir}`)) * 1000
  if (!Number.isFinite(committed) || committed <= 0)
    return yield* Effect.fail(new Error(`unreadable HEAD time in ${dir}`))
  const metadata = yield* Effect.promise(() =>
    Promise.all(
      ["index", "logs/HEAD"].map((file) =>
        stat(path.join(gitdir.text, file)).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      ),
    ),
  )
  return {
    path: dir,
    kind: "worktree" as const,
    repo,
    branch,
    head,
    status,
    hidden,
    submodules,
    dirty,
    unpushed,
    safe: dirty === 0 && (merged || pushed),
    lastActivity: Math.max(committed, ...metadata),
  }
})

// git status never looks inside a submodule's own repository, and a forced
// `git worktree remove` deletes it with any local commits. Same test git uses to
// refuse an unforced remove: a gitlink whose folder has a .git entry, or a
// `modules` folder in the worktree's git dir. Unreadable entries count as present.
const initializedSubmodules = Effect.fnUntraced(function* (dir: string, gitdir: string) {
  const gitlinks = (yield* requireOk(yield* git(dir, ["ls-files", "--stage", "-z"]), `git ls-files --stage in ${dir}`))
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
  const present = (target: string) =>
    lstat(target).then(
      () => true,
      (cause: NodeJS.ErrnoException) => cause.code !== "ENOENT" && cause.code !== "ENOTDIR",
    )
  const checked = yield* Effect.promise(() =>
    Promise.all(gitlinks.map(async (link) => ((await present(path.join(dir, link, ".git"))) ? link : undefined))),
  )
  const initialized = checked.filter((link) => link !== undefined)
  if (initialized.length > 0) return initialized
  const modules = path.join(gitdir, "modules")
  return (yield* Effect.promise(() => present(modules))) ? [modules] : []
})

// A failed command must fail the inspection, never read as an empty (clean/idle) result.
function requireOk(result: { code: number; text: string }, what: string) {
  return result.code === 0 ? Effect.succeed(result.text) : Effect.fail(new Error(`${what} failed`))
}

export * as JanitorInspect from "./inspect"
