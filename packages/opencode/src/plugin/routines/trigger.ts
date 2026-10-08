import { Glob } from "bun"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { Octokit } from "@octokit/rest"
import { Effect } from "effect"
import type { Routine, TriggerGithub } from "./parse"

const PREFIX = "[routines]"
const TRIGGER_STATE_FILE = path.join(Global.Path.state, "routines-trigger-state.json")
const GITHUB_POLL_MS = 5 * 60_000

export async function triggerDue(routine: Routine, directory: string) {
  const patterns = routine.trigger?.files
  if (!patterns || patterns.length === 0) return false
  const since = routine.lastRun ? new Date(routine.lastRun).getTime() : 0
  for (const pattern of patterns) {
    const glob = new Glob(pattern)
    for await (const entry of glob.scan({ cwd: directory, onlyFiles: true })) {
      const stat = await Bun.file(path.join(directory, entry)).stat().catch(() => undefined)
      if (stat && stat.mtime.getTime() > since) return true
    }
  }
  return false
}

type TriggerState = Record<string, { seenAt?: string; checkedAt?: string }>

export async function githubDue(routine: Routine, token: string | undefined, stateFile: string = TRIGGER_STATE_FILE) {
  const github = routine.trigger?.github
  if (!github) return false
  if (!token) {
    console.warn(`${PREFIX} skipping github trigger without GITHUB_TOKEN`)
    return false
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Flock.effect(`routines-trigger-state:${stateFile}`, { staleMs: 10_000, timeoutMs: 30_000 })
      const state = yield* Effect.promise(() => readTriggerState(stateFile))
      const entry = state[routine.id]
      const now = Date.now()
      if (entry?.checkedAt && now - new Date(entry.checkedAt).getTime() < GITHUB_POLL_MS) return false
      const newest = yield* Effect.promise(() => newestUpdatedAt(github, token).catch(() => undefined))
      state[routine.id] = { seenAt: newest ?? entry?.seenAt, checkedAt: new Date(now).toISOString() }
      yield* Effect.promise(() => Bun.write(stateFile, JSON.stringify(state)))
      if (!newest) return false
      if (!entry?.seenAt) return true
      return new Date(newest).getTime() > new Date(entry.seenAt).getTime()
    }).pipe(Effect.scoped),
  )
}

async function newestUpdatedAt(github: TriggerGithub, token: string) {
  const octokit = new Octokit({ auth: token })
  if (github.event === "pr") {
    const listed = await octokit.pulls.list({
      owner: github.owner,
      repo: github.repo,
      sort: "updated",
      direction: "desc",
      per_page: 1,
    })
    return listed.data[0]?.updated_at as string | undefined
  }
  const listed = await octokit.issues.listForRepo({
    owner: github.owner,
    repo: github.repo,
    sort: "updated",
    direction: "desc",
    per_page: 1,
  })
  return listed.data[0]?.updated_at as string | undefined
}

async function readTriggerState(file: string): Promise<TriggerState> {
  if (!(await Bun.file(file).exists())) return {}
  try {
    const parsed = JSON.parse(await Bun.file(file).text()) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as TriggerState
  } catch {
    return {}
  }
}
