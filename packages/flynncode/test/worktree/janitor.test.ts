import { afterEach, beforeEach, describe, expect, setDefaultTimeout } from "bun:test"
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import path from "path"
import { sql } from "drizzle-orm"
import { Duration, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Database } from "@flynncode/core/database/database"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Flag } from "@flynncode/core/flag/flag"
import { Project } from "../../src/project/project"
import { WorktreeJanitor } from "../../src/worktree/janitor/janitor"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Each test drives several real git processes; under load they can outlast bun's 5s default.
setDefaultTimeout(30_000)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([WorktreeJanitor.node, Project.node, Database.node, CrossSpawnSpawner.node])),
)

const OLD_MS = Date.now() - 5 * 24 * 60 * 60 * 1000
const OLD = new Date(OLD_MS).toISOString()

const run = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

// Backdate the worktree's git metadata so it reads as idle.
const age = (worktree: string) => {
  const gitdir = run(worktree, "rev-parse", "--absolute-git-dir")
  for (const file of ["index", "logs/HEAD"]) utimesSync(path.join(gitdir, file), OLD_MS / 1000, OLD_MS / 1000)
}

// Checked-out tracked files are newer than a backdated index, which makes git
// status refresh (and rewrite) the index. Backdate them first and record that.
const settle = (worktree: string) => {
  for (const file of run(worktree, "ls-files").split("\n").filter(Boolean))
    utimesSync(path.join(worktree, file), OLD_MS / 1000 - 100, OLD_MS / 1000 - 100)
  run(worktree, "update-index", "--refresh")
  age(worktree)
}

// The fixture's root commit carries the current time; rewrite it so HEAD's
// committer time is old too, then register the repo as a Flynncode project.
const setupRepo = Effect.gen(function* () {
  const repo = yield* tmpdirScoped({ git: true })
  run(repo, "branch", "-M", "main")
  run(repo, "commit", "--amend", "--allow-empty", "--no-edit")
  const project = yield* Project.Service
  const registered = yield* project.fromDirectory(repo)
  return { repo, projectID: registered.project.id }
})

const addWorktree = (repo: string, name: string, branch: string) => {
  const dir = path.join(repo, ".worktrees", name)
  run(repo, "worktree", "add", "-b", branch, dir)
  return dir
}

const put = (root: string, file: string, content = "x".repeat(100)) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), content)
}

const scan = Effect.gen(function* () {
  const janitor = yield* WorktreeJanitor.Service
  return yield* janitor.scan()
})

const item = (report: WorktreeJanitor.Report, dir: string) => report.items.find((entry) => entry.path === dir)

const ignore = (repo: string, patterns: string) => {
  put(repo, ".gitignore", patterns)
  run(repo, "add", ".gitignore")
  run(repo, "commit", "-m", "ignore")
}

describe("WorktreeJanitor.scan", () => {
  it.effect("auto-removes a clean merged idle worktree and keeps its branch", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "merged", "merged-branch")
      age(dir)
      const report = yield* scan
      expect(existsSync(dir)).toBe(false)
      expect(run(repo, "branch", "--list", "merged-branch")).toContain("merged-branch")
      expect(run(repo, "worktree", "list", "--porcelain")).not.toContain(dir)
      expect(report.cleaned).toContainEqual(expect.objectContaining({ path: dir, kind: "worktree" }))
      expect(item(report, dir)).toBeUndefined()
      expect(report.scanning).toBe(false)
      expect(report.lastScan).toBeNumber()
    }),
  )

  it.effect("keeps a recently used clean worktree as recent", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "fresh", "fresh-branch")
      const report = yield* scan
      expect(existsSync(dir)).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "recent", branch: "fresh-branch", project: repo, repo })
      expect(report.cleaned).toEqual([])
    }),
  )

  it.effect("keeps an idle worktree with an untracked file as dirty", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "dirty", "dirty-branch")
      put(dir, "notes.txt")
      age(dir)
      const report = yield* scan
      expect(existsSync(path.join(dir, "notes.txt"))).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "dirty", detail: "1 changed files" })
      expect(item(report, dir)?.bytes).toBeGreaterThan(0)
    }),
  )

  it.effect("keeps an idle worktree with an unpushed commit as unpushed", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "ahead", "ahead-branch")
      run(dir, "commit", "--allow-empty", "-m", "extra")
      age(dir)
      const report = yield* scan
      expect(existsSync(dir)).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "unpushed", detail: "1 unpushed commits" })
    }),
  )

  it.effect("removes junk from an idle worktree and then the worktree itself", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "junky", "junky-branch")
      put(dir, "pytest-of-x/big.bin", "y".repeat(4096))
      age(dir)
      const report = yield* scan
      expect(existsSync(dir)).toBe(false)
      expect(report.cleaned).toContainEqual(
        expect.objectContaining({ path: path.join(dir, "pytest-of-x"), kind: "junk", bytes: 4096 }),
      )
      expect(report.cleaned).toContainEqual(expect.objectContaining({ path: dir, kind: "worktree" }))
      expect(run(repo, "branch", "--list", "junky-branch")).toContain("junky-branch")
    }),
  )

  it.effect("keeps tracked junk-named directories", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      put(repo, "coverage/report.txt")
      run(repo, "add", "coverage/report.txt")
      run(repo, "commit", "-m", "tracked coverage")
      const dir = addWorktree(repo, "tracked", "tracked-branch")
      put(dir, "pkg/__pycache__/a.pyc")
      put(dir, "notes.txt")
      settle(dir)
      const report = yield* scan
      expect(existsSync(path.join(dir, "coverage/report.txt"))).toBe(true)
      expect(existsSync(path.join(dir, "pkg/__pycache__"))).toBe(false)
      expect(report.cleaned.map((entry) => entry.path)).not.toContain(path.join(dir, "coverage"))
      expect(item(report, dir)).toMatchObject({ reason: "dirty" })
    }),
  )

  it.effect("lists a scratch folder and never deletes it", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const scratch = path.join(repo, ".worktrees", "notes")
      put(scratch, "todo.md")
      utimesSync(path.join(scratch, "todo.md"), OLD_MS / 1000, OLD_MS / 1000)
      utimesSync(scratch, OLD_MS / 1000, OLD_MS / 1000)
      const report = yield* scan
      expect(existsSync(path.join(scratch, "todo.md"))).toBe(true)
      expect(item(report, scratch)).toMatchObject({ reason: "scratch" })
    }),
  )

  it.effect("keeps an idle worktree a session is still using", () =>
    Effect.gen(function* () {
      const { repo, projectID } = yield* setupRepo
      const dir = addWorktree(repo, "busy", "busy-branch")
      age(dir)
      const database = yield* Database.Service
      const now = Date.now()
      yield* database.db
        .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                 VALUES ('ses_busy', ${projectID}, 'b', ${dir}, 't', '1', ${now}, ${now})`)
      const report = yield* scan
      expect(existsSync(dir)).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "recent" })
    }),
  )

  it.effect("keeps an idle worktree whose old session has a recent part", () =>
    Effect.gen(function* () {
      const { repo, projectID } = yield* setupRepo
      const dir = addWorktree(repo, "streaming", "streaming-branch")
      age(dir)
      const database = yield* Database.Service
      const now = Date.now()
      yield* database.db
        .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                 VALUES ('ses_stream', ${projectID}, 's', ${path.join(dir, "pkg")}, 't', '1', 1, 1)`)
      yield* database.db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
                                 VALUES ('msg_stream', 'ses_stream', 1, 1, '{}')`)
      yield* database.db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                                 VALUES ('prt_stream', 'msg_stream', 'ses_stream', ${now}, ${now}, '{}')`)
      const report = yield* scan
      expect(existsSync(dir)).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "recent" })
    }),
  )

  it.effect("keeps an idle clean merged worktree that holds ignored local files", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      ignore(repo, ".env\ndist/\n")
      const dir = addWorktree(repo, "secrets", "secrets-branch")
      put(dir, ".env", "TOKEN=local")
      put(dir, "dist/bundle.js")
      settle(dir)
      const report = yield* scan
      expect(existsSync(path.join(dir, ".env"))).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "dirty" })
      expect(item(report, dir)?.detail).toContain("1 ignored local files, e.g. .env")
    }),
  )

  it.effect("auto-removes an idle clean merged worktree whose ignored files are all regenerable", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      ignore(repo, ".env\ndist/\ncoverage/\n")
      const dir = addWorktree(repo, "built", "built-branch")
      put(dir, "dist/bundle.js")
      put(dir, "coverage/lcov.info")
      settle(dir)
      const report = yield* scan
      expect(existsSync(dir)).toBe(false)
      expect(report.cleaned).toContainEqual(expect.objectContaining({ path: path.join(dir, "coverage"), kind: "junk" }))
      expect(report.cleaned).toContainEqual(expect.objectContaining({ path: dir, kind: "worktree" }))
    }),
  )

  it.effect("keeps an untracked coverage folder that git does not ignore", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "cov", "cov-branch")
      put(dir, "coverage/index.ts")
      age(dir)
      const report = yield* scan
      expect(existsSync(path.join(dir, "coverage/index.ts"))).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "dirty" })
    }),
  )

  it.effect("never auto-removes an idle clean worktree git lists outside the cleanup folders", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const outside = yield* tmpdirScoped()
      const dir = path.join(outside, "parked")
      run(repo, "worktree", "add", "-b", "parked-branch", dir)
      age(dir)
      const report = yield* scan
      expect(existsSync(dir)).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "recent", branch: "parked-branch" })
      expect(item(report, dir)?.detail).toContain("remove manually")
      expect(report.cleaned).toEqual([])
    }),
  )

  it.effect("never auto-removes a worktree on the default branch or on dev/main/master", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dev = addWorktree(repo, "dev", "dev")
      run(repo, "branch", "trunk")
      run(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD")
      run(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
      const trunk = path.join(repo, ".worktrees", "trunk")
      run(repo, "worktree", "add", trunk, "trunk")
      age(dev)
      age(trunk)
      const report = yield* scan
      expect(existsSync(dev)).toBe(true)
      expect(existsSync(trunk)).toBe(true)
      expect(item(report, dev)).toMatchObject({ reason: "recent", branch: "dev" })
      expect(item(report, trunk)).toMatchObject({ reason: "recent", branch: "trunk" })
      expect(item(report, trunk)?.detail).toContain("remove manually")
      expect(report.cleaned).toEqual([])
    }),
  )

  it.effect("never follows a symlinked cleanup folder", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const elsewhere = yield* tmpdirScoped()
      const linked = path.join(elsewhere, "linked")
      run(repo, "worktree", "add", "-b", "linked-branch", linked)
      age(linked)
      put(elsewhere, "notes/todo.md")
      symlinkSync(elsewhere, path.join(repo, ".worktrees"))
      const report = yield* scan
      expect(existsSync(linked)).toBe(true)
      expect(item(report, linked)?.detail).toContain("remove manually")
      expect(item(report, path.join(elsewhere, "notes"))).toBeUndefined()
      expect(report.cleaned).toEqual([])
    }),
  )

  it.effect("shows what removal would lose on a recent worktree", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      ignore(repo, ".env\n")
      const dir = addWorktree(repo, "busy", "busy-branch")
      run(dir, "commit", "--allow-empty", "-m", "extra")
      put(dir, "notes.txt")
      put(dir, ".env", "TOKEN=local")
      const listed = item(yield* scan, dir)
      expect(listed).toMatchObject({
        reason: "recent",
        dirty: 1,
        unpushed: 1,
        ignored: 1,
        ignoredExample: ".env",
        detached: false,
        head: run(dir, "rev-parse", "HEAD"),
      })
      expect(listed?.detail).toContain("1 changed files")
      expect(listed?.detail).toContain("1 unpushed commits")
      expect(listed?.detail).toContain("1 ignored local files, e.g. .env")
      expect(listed).not.toHaveProperty("fingerprint")
    }),
  )

  it.effect("marks a detached worktree as detached", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = path.join(repo, ".worktrees", "loose")
      run(repo, "worktree", "add", "--detach", dir)
      expect(item(yield* scan, dir)).toMatchObject({ detached: true, branch: undefined })
    }),
  )

  it.effect("keeps an ignored file inside a tracked out/ folder", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      put(repo, "tools/out/keep.txt")
      run(repo, "add", "tools/out/keep.txt")
      run(repo, "commit", "-m", "tracked out")
      ignore(repo, "secrets.json\ndist/\n")
      const dir = addWorktree(repo, "tools", "tools-branch")
      put(dir, "tools/out/secrets.json", "{}")
      put(dir, "dist/bundle.js")
      settle(dir)
      const report = yield* scan
      expect(existsSync(path.join(dir, "tools/out/secrets.json"))).toBe(true)
      expect(item(report, dir)).toMatchObject({
        reason: "dirty",
        ignored: 1,
        ignoredExample: "tools/out/secrets.json",
      })
    }),
  )

  it.effect("never auto-removes an untracked file that status.showUntrackedFiles=no hides", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      run(repo, "config", "status.showUntrackedFiles", "no")
      const dir = addWorktree(repo, "hidden", "hidden-branch")
      put(dir, "notes.txt")
      age(dir)
      const report = yield* scan
      expect(existsSync(path.join(dir, "notes.txt"))).toBe(true)
      expect(item(report, dir)).toMatchObject({ reason: "dirty", dirty: 1 })
    }),
  )

  it.effect("lists a worktree it cannot inspect as an error and keeps it", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const broken = path.join(repo, ".worktrees", "broken")
      put(broken, ".git", "gitdir: /nonexistent/worktrees/broken\n")
      put(broken, "work.txt")
      const report = yield* scan
      expect(existsSync(path.join(broken, "work.txt"))).toBe(true)
      expect(item(report, broken)).toMatchObject({ reason: "error" })
      expect(item(report, broken)?.detail).toBeString()
    }),
  )
})

describe("WorktreeJanitor.remove", () => {
  it.effect("force-removes a listed dirty worktree and refuses unlisted paths", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "dirty", "dirty-branch")
      put(dir, "notes.txt")
      age(dir)
      yield* scan
      const janitor = yield* WorktreeJanitor.Service
      expect(yield* janitor.remove([dir])).toEqual([{ path: dir, ok: true }])
      expect(existsSync(dir)).toBe(false)
      expect(run(repo, "branch", "--list", "dirty-branch")).toContain("dirty-branch")
      const refused = yield* janitor.remove(["/etc", repo])
      expect(refused.map((result) => result.ok)).toEqual([false, false])
      expect(refused[0].error).toContain("not on the cleanup review list")
      expect(existsSync("/etc")).toBe(true)
      expect(existsSync(path.join(repo, ".git"))).toBe(true)
      const report = yield* janitor.report()
      expect(item(report, dir)).toBeUndefined()
      expect(report.cleaned).toContainEqual(expect.objectContaining({ path: dir, kind: "worktree" }))
    }),
  )

  it.effect("refuses a listed worktree that changed since the scan", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "ahead", "ahead-branch")
      run(dir, "commit", "--allow-empty", "-m", "extra")
      age(dir)
      expect(item(yield* scan, dir)).toMatchObject({ reason: "unpushed" })
      put(dir, "new-work.txt")
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir])
      expect(results[0]).toMatchObject({ path: dir, ok: false })
      expect(results[0].error).toContain("changed since the last scan; rescan first")
      expect(existsSync(path.join(dir, "new-work.txt"))).toBe(true)
    }),
  )

  it.effect("refuses a worktree whose changes were swapped since the scan", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "swap", "swap-branch")
      put(dir, "first.txt")
      age(dir)
      expect(item(yield* scan, dir)).toMatchObject({ reason: "dirty", dirty: 1 })
      run(dir, "add", "first.txt")
      run(dir, "commit", "-m", "first")
      put(dir, "second.txt")
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir])
      expect(results[0]).toMatchObject({ path: dir, ok: false })
      expect(results[0].error).toContain("changed since the last scan; rescan first")
      expect(existsSync(path.join(dir, "second.txt"))).toBe(true)
    }),
  )

  it.effect("refuses a scratch folder that gained a file since the scan", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const scratch = path.join(repo, ".worktrees", "notes")
      put(scratch, "todo.md")
      utimesSync(path.join(scratch, "todo.md"), OLD_MS / 1000, OLD_MS / 1000)
      utimesSync(scratch, OLD_MS / 1000, OLD_MS / 1000)
      expect(item(yield* scan, scratch)).toMatchObject({ reason: "scratch" })
      put(scratch, "later.md")
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([scratch])
      expect(results[0]).toMatchObject({ path: scratch, ok: false })
      expect(results[0].error).toContain("changed since the last scan; rescan first")
      expect(existsSync(path.join(scratch, "later.md"))).toBe(true)
    }),
  )

  it.effect("refuses a detached worktree that gained a commit since the scan", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = path.join(repo, ".worktrees", "loose")
      run(repo, "worktree", "add", "--detach", dir)
      run(dir, "commit", "--allow-empty", "-m", "one")
      age(dir)
      expect(item(yield* scan, dir)).toMatchObject({ reason: "unpushed", detached: true })
      run(dir, "commit", "--allow-empty", "-m", "two")
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir])
      expect(results[0]).toMatchObject({ path: dir, ok: false })
      expect(results[0].error).toContain("changed since the last scan; rescan first")
      expect(existsSync(dir)).toBe(true)
    }),
  )

  it.effect("rescues unpushed commits of a detached worktree onto a branch before removing it", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = path.join(repo, ".worktrees", "loose")
      run(repo, "worktree", "add", "--detach", dir)
      run(dir, "commit", "--allow-empty", "-m", "only here")
      age(dir)
      const head = run(dir, "rev-parse", "HEAD")
      const name = `janitor/rescued-${head.slice(0, 7)}`
      // An earlier rescue already took the plain name.
      run(repo, "branch", name, "main")
      yield* scan
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir])
      expect(results).toEqual([{ path: dir, ok: true, rescued: `${name}-2` }])
      expect(existsSync(dir)).toBe(false)
      expect(run(repo, "rev-parse", `refs/heads/${name}-2`)).toBe(head)
      expect((yield* janitor.report()).cleaned).toContainEqual(
        expect.objectContaining({ path: dir, kind: "worktree", rescued: `${name}-2` }),
      )
    }),
  )

  it.effect("refuses a worktree that gained a file inside a listed untracked folder", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "drafts", "drafts-branch")
      put(dir, "drafts/one.txt")
      age(dir)
      expect(item(yield* scan, dir)).toMatchObject({ reason: "dirty", dirty: 1 })
      put(dir, "drafts/two.txt")
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir])
      expect(results[0]).toMatchObject({ path: dir, ok: false })
      expect(results[0].error).toContain("changed since the last scan; rescan first")
      expect(existsSync(path.join(dir, "drafts/two.txt"))).toBe(true)
    }),
  )

  it.effect("refuses a worktree that gained a file inside a listed ignored folder", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      ignore(repo, ".secrets/\n")
      const dir = addWorktree(repo, "vault", "vault-branch")
      put(dir, ".secrets/one.key")
      settle(dir)
      expect(item(yield* scan, dir)).toMatchObject({
        reason: "dirty",
        ignored: 1,
        ignoredExample: ".secrets/one.key",
      })
      put(dir, ".secrets/two.key")
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir])
      expect(results[0]).toMatchObject({ path: dir, ok: false })
      expect(results[0].error).toContain("changed since the last scan; rescan first")
      expect(existsSync(path.join(dir, ".secrets/two.key"))).toBe(true)
    }),
  )

  it.effect("refuses a scratch folder that gained a file deep inside since the scan", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const scratch = path.join(repo, ".worktrees", "notes")
      put(scratch, "a/b/todo.md")
      for (const entry of ["a/b/todo.md", "a/b", "a", "."])
        utimesSync(path.join(scratch, entry), OLD_MS / 1000, OLD_MS / 1000)
      expect(item(yield* scan, scratch)).toMatchObject({ reason: "scratch" })
      put(scratch, "a/b/later.md")
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([scratch])
      expect(results[0]).toMatchObject({ path: scratch, ok: false })
      expect(results[0].error).toContain("changed since the last scan; rescan first")
      expect(existsSync(path.join(scratch, "a/b/later.md"))).toBe(true)
    }),
  )

  it.effect("refuses a scratch folder it cannot fully check", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const scratch = path.join(repo, ".worktrees", "notes")
      const locked = path.join(scratch, "locked")
      put(scratch, "locked/todo.md")
      expect(item(yield* scan, scratch)).toMatchObject({ reason: "scratch" })
      chmodSync(locked, 0o000)
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor
        .remove([scratch])
        .pipe(Effect.ensuring(Effect.sync(() => chmodSync(locked, 0o755))))
      expect(results[0]).toMatchObject({ path: scratch, ok: false })
      expect(results[0].error).toBe("too large or unreadable to verify; rescan first")
      expect(existsSync(path.join(locked, "todo.md"))).toBe(true)
    }),
  )

  it.effect("reports the rescue branch when removing a locked detached worktree fails", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = path.join(repo, ".worktrees", "loose")
      run(repo, "worktree", "add", "--detach", dir)
      run(dir, "commit", "--allow-empty", "-m", "only here")
      age(dir)
      const head = run(dir, "rev-parse", "HEAD")
      yield* scan
      run(repo, "worktree", "lock", dir)
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir])
      run(repo, "worktree", "unlock", dir)
      expect(results[0]).toMatchObject({ path: dir, ok: false, rescued: `janitor/rescued-${head.slice(0, 7)}` })
      expect(results[0].error).toBeString()
      expect(existsSync(dir)).toBe(true)
      expect(run(repo, "rev-parse", `refs/heads/janitor/rescued-${head.slice(0, 7)}`)).toBe(head)
    }),
  )

  it.effect("refuses an item whose inspection failed with a manual-fix message", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const broken = path.join(repo, ".worktrees", "broken")
      put(broken, ".git", "gitdir: /nonexistent/worktrees/broken\n")
      put(broken, "work.txt")
      expect(item(yield* scan, broken)).toMatchObject({ reason: "error" })
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([broken])
      expect(results[0]).toMatchObject({ path: broken, ok: false })
      expect(results[0].error).toBe("this item could not be inspected; fix or remove it manually")
      expect(existsSync(path.join(broken, "work.txt"))).toBe(true)
    }),
  )

  it.effect("refuses a worktree that switched branch since the scan", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "switch", "switch-branch")
      put(dir, "notes.txt")
      age(dir)
      yield* scan
      run(dir, "checkout", "-q", "-b", "other-branch")
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir])
      expect(results[0]).toMatchObject({ path: dir, ok: false })
      expect(results[0].error).toContain("changed since the last scan; rescan first")
      expect(existsSync(path.join(dir, "notes.txt"))).toBe(true)
    }),
  )

  it.effect("refuses an item that turned from worktree into scratch or back", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const dir = addWorktree(repo, "was-worktree", "was-branch")
      put(dir, "notes.txt")
      age(dir)
      const scratch = path.join(repo, ".worktrees", "was-scratch")
      put(scratch, "todo.md")
      yield* scan
      rmSync(path.join(dir, ".git"))
      rmSync(scratch, { recursive: true })
      run(repo, "worktree", "add", "-b", "now-branch", scratch)
      const janitor = yield* WorktreeJanitor.Service
      const results = yield* janitor.remove([dir, scratch])
      expect(results.map((result) => result.ok)).toEqual([false, false])
      expect(results.map((result) => result.error)).toEqual([
        "changed since the last scan; rescan first",
        "changed since the last scan; rescan first",
      ])
      expect(existsSync(path.join(dir, "notes.txt"))).toBe(true)
      expect(existsSync(scratch)).toBe(true)
    }),
  )

  it.effect("deletes a listed scratch folder", () =>
    Effect.gen(function* () {
      const { repo } = yield* setupRepo
      const scratch = path.join(repo, ".worktrees", "notes")
      put(scratch, "todo.md")
      yield* scan
      const janitor = yield* WorktreeJanitor.Service
      expect(yield* janitor.remove([scratch])).toEqual([{ path: scratch, ok: true }])
      expect(existsSync(scratch)).toBe(false)
      expect(existsSync(repo)).toBe(true)
      expect((yield* janitor.report()).cleaned).toContainEqual(
        expect.objectContaining({ path: scratch, kind: "scratch" }),
      )
    }),
  )
})

describe("WorktreeJanitor hourly loop", () => {
  // Moves the test clock past the loop's 2 minute start delay. remove() shares the
  // scan's cleanup lock, so it returns once any scan the clock started has cleaned up.
  const firstScheduledScan = Effect.gen(function* () {
    const { repo } = yield* setupRepo
    const dir = addWorktree(repo, "scheduled", "scheduled-branch")
    age(dir)
    yield* TestClock.adjust(Duration.minutes(3))
    const janitor = yield* WorktreeJanitor.Service
    yield* janitor.remove([])
    return { exists: existsSync(dir), lastScan: (yield* janitor.report()).lastScan }
  })

  it.effect("scans on its hourly schedule", () =>
    Effect.gen(function* () {
      const result = yield* firstScheduledScan
      expect(result.exists).toBe(false)
      expect(result.lastScan).toBeNumber()
    }),
  )

  describe("with OPENCODE_DISABLE_WORKTREE_CLEANUP", () => {
    const original = Flag.OPENCODE_DISABLE_WORKTREE_CLEANUP
    // Set before the layer is built, which is when the loop is scheduled.
    beforeEach(() => {
      Flag.OPENCODE_DISABLE_WORKTREE_CLEANUP = true
    })
    afterEach(() => {
      Flag.OPENCODE_DISABLE_WORKTREE_CLEANUP = original
    })

    it.effect("does not schedule the scan", () =>
      Effect.gen(function* () {
        const result = yield* firstScheduledScan
        expect(result.exists).toBe(true)
        expect(result.lastScan).toBeUndefined()
      }),
    )
  })
})
