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
      dirty: number
      unpushed: number
      safe: boolean
      lastActivity: number
    }
  // `capped`: the walk ran out of time or hit an unreadable folder, so a newer
  // file may be missing from lastActivity.
  | { path: string; kind: "scratch"; lastActivity: number; capped: boolean }
  | { path: string; kind: "main" }

export const git = Effect.fnUntraced(function* (cwd: string, args: string[]) {
  const proc = yield* AppProcess.Service
  return yield* proc.run(ChildProcess.make("git", args, { cwd, extendEnv: true, stdin: "ignore" })).pipe(
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
    return { path: dir, kind: "scratch" as const, lastActivity: walk.mtime, capped: walk.capped }
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
  const dirty = status ? status.split("\n").length : 0
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
    dirty,
    unpushed,
    safe: dirty === 0 && (merged || pushed),
    lastActivity: Math.max(committed, ...metadata),
  }
})

// A failed command must fail the inspection, never read as an empty (clean/idle) result.
function requireOk(result: { code: number; text: string }, what: string) {
  return result.code === 0 ? Effect.succeed(result.text) : Effect.fail(new Error(`${what} failed`))
}

export * as JanitorInspect from "./inspect"
