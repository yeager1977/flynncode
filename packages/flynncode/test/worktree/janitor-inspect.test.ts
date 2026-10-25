import { describe, expect } from "bun:test"
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs"
import path from "path"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { AppProcess } from "@flynncode/core/process"
import { Effect } from "effect"
import { JanitorInspect } from "../../src/worktree/janitor/inspect"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, AppProcess.node])))

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

// The fixture's root commit carries the current time; rewrite it so HEAD's committer time is old too.
const setupRepo = Effect.gen(function* () {
  const repo = yield* tmpdirScoped({ git: true })
  run(repo, "branch", "-M", "main")
  run(repo, "commit", "--amend", "--allow-empty", "--no-edit")
  return repo
})

const addWorktree = (repo: string, name: string, branch: string) => {
  const dir = path.join(repo, ".worktrees", name)
  run(repo, "worktree", "add", "-b", branch, dir)
  return dir
}

const commit = (cwd: string, message: string) => run(cwd, "commit", "--allow-empty", "-m", message)

describe("JanitorInspect.inspect", () => {
  it.effect("reports a merged clean worktree as safe", () =>
    Effect.gen(function* () {
      const repo = yield* setupRepo
      const dir = addWorktree(repo, "merged", "merged-branch")
      age(dir)
      const result = yield* JanitorInspect.inspect(dir)
      expect(result).toMatchObject({
        kind: "worktree",
        repo,
        branch: "merged-branch",
        dirty: 0,
        unpushed: 0,
        safe: true,
      })
      if (result.kind !== "worktree") throw new Error("expected worktree")
      expect(result.lastActivity).toBeLessThanOrEqual(OLD_MS + 1000)
    }),
  )

  it.effect("reports an unmerged unpushed commit as unsafe", () =>
    Effect.gen(function* () {
      const repo = yield* setupRepo
      const dir = addWorktree(repo, "ahead", "ahead-branch")
      commit(dir, "extra")
      age(dir)
      expect(yield* JanitorInspect.inspect(dir)).toMatchObject({ kind: "worktree", safe: false, unpushed: 1, dirty: 0 })
    }),
  )

  it.effect("reports a pushed but unmerged branch as safe", () =>
    Effect.gen(function* () {
      const repo = yield* setupRepo
      const remote = path.join(repo, "remote.git")
      run(repo, "init", "--bare", remote)
      run(repo, "remote", "add", "origin", remote)
      run(repo, "push", "origin", "main")
      const dir = addWorktree(repo, "pushed", "pushed-branch")
      commit(dir, "extra")
      run(dir, "push", "-u", "origin", "pushed-branch")
      age(dir)
      expect(yield* JanitorInspect.inspect(dir)).toMatchObject({ kind: "worktree", safe: true, unpushed: 0, dirty: 0 })
    }),
  )

  it.effect("counts untracked files as dirty", () =>
    Effect.gen(function* () {
      const repo = yield* setupRepo
      const dir = addWorktree(repo, "dirty", "dirty-branch")
      writeFileSync(path.join(dir, "note.txt"), "x")
      age(dir)
      expect(yield* JanitorInspect.inspect(dir)).toMatchObject({ kind: "worktree", dirty: 1, safe: false })
    }),
  )

  it.effect("classifies a folder without .git as scratch", () =>
    Effect.gen(function* () {
      const repo = yield* setupRepo
      const dir = path.join(repo, ".worktrees", "scratch")
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "a.txt"), "x")
      const result = yield* JanitorInspect.inspect(dir)
      expect(result.kind).toBe("scratch")
      if (result.kind !== "scratch") throw new Error("expected scratch")
      expect(result.lastActivity).toBeGreaterThan(OLD_MS)
    }),
  )

  it.effect("classifies the repo root as main", () =>
    Effect.gen(function* () {
      const repo = yield* setupRepo
      expect(yield* JanitorInspect.inspect(repo)).toEqual({ path: repo, kind: "main" })
    }),
  )

  it.effect("resolves the owning repo of a nested repo's worktree", () =>
    Effect.gen(function* () {
      const repo = yield* setupRepo
      const inner = path.join(repo, "inner")
      mkdirSync(inner)
      run(inner, "init", "-b", "main")
      run(inner, "-c", "user.email=t@t.test", "-c", "user.name=T", "commit", "--allow-empty", "-m", "root")
      const dir = path.join(repo, ".worktrees", "inner-wt")
      run(inner, "worktree", "add", "-b", "inner-branch", dir)
      expect(yield* JanitorInspect.inspect(dir)).toMatchObject({ kind: "worktree", repo: realpathSync(inner) })
    }),
  )
})
