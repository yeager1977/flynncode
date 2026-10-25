import { AppProcess } from "@flynncode/core/process"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { lstat, readdir, realpath, stat } from "node:fs/promises"
import path from "path"

export type Inspection =
  | {
      path: string
      kind: "worktree"
      repo: string
      branch?: string
      dirty: number
      unpushed: number
      safe: boolean
      lastActivity: number
    }
  | { path: string; kind: "scratch"; lastActivity: number }
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
  if (origin.code === 0 && origin.text) return origin.text
  for (const name of ["dev", "main", "master"]) {
    const local = yield* git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])
    if (local.code === 0) return name
    const remote = yield* git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])
    if (remote.code === 0) return `origin/${name}`
  }
  return undefined
})

export const inspect = Effect.fn("JanitorInspect.inspect")(function* (target: string) {
  const dir = yield* Effect.promise(() => realpath(target))
  const dotGit = yield* Effect.promise(() => lstat(path.join(dir, ".git")).catch(() => undefined))
  if (!dotGit)
    return { path: dir, kind: "scratch" as const, lastActivity: yield* Effect.promise(() => folderActivity(dir)) }
  if (dotGit.isDirectory()) return { path: dir, kind: "main" as const }

  // A worktree's .git file points into <repo>/.git/worktrees/<name>; the owning
  // repo is the common dir's parent, which also covers nested repos whose
  // worktrees live in a parent project's .worktrees/.
  const common = yield* git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const gitdir = yield* git(dir, ["rev-parse", "--absolute-git-dir"])
  if (common.code !== 0 || gitdir.code !== 0) return yield* Effect.fail(new Error(`not a git worktree: ${dir}`))
  const repo = path.dirname(common.text)
  const branch = (yield* git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).text || undefined
  const status = yield* git(dir, ["status", "--porcelain"])
  const dirty = status.text ? status.text.split("\n").length : 0
  const base = yield* defaultBranch(repo)
  const unpushed = Number(
    (yield* git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes", ...(base ? [base] : [])])).text || "0",
  )
  const merged = base ? (yield* git(dir, ["merge-base", "--is-ancestor", "HEAD", base])).code === 0 : false
  const upstream = yield* git(dir, ["rev-list", "--count", "@{u}..HEAD"])
  const pushed =
    (upstream.code === 0 && upstream.text === "0") ||
    (yield* git(dir, ["branch", "-r", "--contains", "HEAD"])).text !== ""
  const committed = Number((yield* git(dir, ["log", "-1", "--format=%ct"])).text || "0") * 1000
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
    dirty,
    unpushed,
    safe: dirty === 0 && (merged || pushed),
    lastActivity: Math.max(committed, ...metadata),
  }
})

async function folderActivity(dir: string) {
  const entries = await readdir(dir).catch(() => [])
  const times = await Promise.all(
    [dir, ...entries.map((entry) => path.join(dir, entry))].map((file) =>
      lstat(file).then(
        (info) => info.mtimeMs,
        () => 0,
      ),
    ),
  )
  return Math.max(0, ...times)
}

export * as JanitorInspect from "./inspect"
