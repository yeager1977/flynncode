import { afterEach, beforeEach, describe, expect } from "bun:test"
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
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
    }),
  )
})

describe("WorktreeJanitor hourly loop", () => {
  // Runs the loop's first scan (2 minutes after start) on the test clock, then
  // waits in real time for the git work to finish.
  const firstScheduledScan = Effect.gen(function* () {
    const { repo } = yield* setupRepo
    const dir = addWorktree(repo, "scheduled", "scheduled-branch")
    age(dir)
    yield* TestClock.adjust(Duration.minutes(3))
    const janitor = yield* WorktreeJanitor.Service
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((yield* janitor.report()).lastScan !== undefined) break
      yield* Effect.promise(() => Bun.sleep(50))
    }
    return existsSync(dir)
  })

  it.effect(
    "scans on its hourly schedule",
    () =>
      Effect.gen(function* () {
        expect(yield* firstScheduledScan).toBe(false)
      }),
    15_000,
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

    it.effect(
      "does not schedule the scan",
      () =>
        Effect.gen(function* () {
          expect(yield* firstScheduledScan).toBe(true)
        }),
      15_000,
    )
  })
})
