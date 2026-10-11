import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "fs/promises"
import path from "path"
import { parse } from "jsonc-parser"
import { Global } from "@flynncode/core/global"
import type { PluginInput } from "@flynncode/plugin"
import { loadRoutines, markRan, readRoutineRuns, runTick } from "../../../src/plugin/routines/index"

const CONFIG = path.join(Global.Path.config, "opencode.jsonc")

afterEach(async () => {
  await rm(CONFIG, { force: true })
})

async function writeConfig(routines: unknown[]) {
  await Bun.write(CONFIG, JSON.stringify({ $schema: "https://opencode.ai/config.json", routines: { routines } }, null, 2))
}

async function readConfig() {
  return parse(await Bun.file(CONFIG).text()) as { routines: { routines: Record<string, unknown>[] } }
}

function fakeClient() {
  const created: string[] = []
  const statusCalls: string[] = []
  const client = {
    session: {
      create: async (input: { body: { title: string }; query: { directory: string } }) => {
        created.push(`${input.body.title}@${input.query.directory}`)
        return { data: { id: `ses_${created.length}` } }
      },
      promptAsync: async () => ({ data: undefined }),
      status: async (input: { query: { directory: string } }) => {
        statusCalls.push(input.query.directory)
        return { data: {} }
      },
    },
  }
  // Only the session calls the scheduler makes are needed here.
  return { created, statusCalls, client: client as unknown as PluginInput["client"] }
}

// A stand-in remote OpenCode server: records every request (with its auth
// header) so tests can pin which endpoint a targeted routine actually hit.
function targetServer(statusBody: Record<string, unknown> = {}) {
  const requests: { method: string; pathname: string; authorization?: string }[] = []
  const sessions: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization") ?? undefined
      requests.push({ method: request.method, pathname: url.pathname, authorization })
      if (request.method === "POST" && url.pathname === "/session") {
        const id = `ses_${sessions.length + 1}`
        sessions.push(id)
        return Response.json({ id, directory: url.searchParams.get("directory") })
      }
      if (url.pathname === "/session/status" && request.method === "GET") return Response.json(statusBody)
      if (url.pathname === "/session/prompt_async" || /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
        return Response.json({})
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, sessions, stop: () => server.stop(true) }
}

describe("markRan", () => {
  test("writes config.routines as an object wrapping the list", async () => {
    await writeConfig([{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" } }])
    await markRan([{ id: "a", summary: { startedAt: "x", endedAt: "y", state: "ok" } }], new Date(2026, 8, 22, 9, 0))
    const config = await readConfig()
    expect(Array.isArray(config.routines)).toBe(false)
    expect(config.routines.routines[0]).toMatchObject({ id: "a", lastRun: new Date(2026, 8, 22, 9, 0).toISOString() })
  })

  test("keeps edits and other routines' lastRun made during the tick", async () => {
    await writeConfig([
      { id: "a", name: "A", prompt: "go", schedule: { interval: "1h" } },
      { id: "b", name: "B", prompt: "old", schedule: { interval: "1h" } },
    ])
    // Another process marks b and the user edits b's prompt mid-tick.
    await writeConfig([
      { id: "a", name: "A", prompt: "go", schedule: { interval: "1h" } },
      { id: "b", name: "B", prompt: "edited", lastRun: "2026-09-22T08:00:00.000Z", schedule: { interval: "1h" } },
    ])
    await markRan([{ id: "a", summary: { startedAt: "x", endedAt: "y", state: "ok" } }], new Date(2026, 8, 22, 9, 0))
    const routines = (await loadRoutines()).routines
    expect(routines.find((routine) => routine.id === "b")).toMatchObject({
      prompt: "edited",
      lastRun: "2026-09-22T08:00:00.000Z",
    })
    expect(routines.find((routine) => routine.id === "a")?.lastRun).toBe(new Date(2026, 8, 22, 9, 0).toISOString())
  })

  test("stamps createdAt on routines that lack it", async () => {
    await writeConfig([{ id: "a", name: "A", prompt: "go", schedule: { interval: "1h" } }])
    await markRan([], new Date(2026, 8, 22, 9, 0))
    expect((await loadRoutines()).routines[0]?.createdAt).toBe(new Date(2026, 8, 22, 9, 0).toISOString())
  })

  test("keeps a routine's target", async () => {
    await writeConfig([
      {
        id: "a",
        name: "A",
        prompt: "go",
        schedule: { interval: "1h" },
        target: { url: "http://deepthought.local:4096", username: "opencode", password: "secret" },
      },
    ])
    await markRan([{ id: "a", summary: { startedAt: "x", endedAt: "y", state: "ok" } }], new Date(2026, 8, 22, 9, 0))
    expect((await loadRoutines()).routines[0]?.target).toEqual({
      url: "http://deepthought.local:4096",
      username: "opencode",
      password: "secret",
    })
  })
})

describe("runTick", () => {
  test("concurrent ticks run a due routine once, in the home directory by default", async () => {
    await writeConfig([{ id: "a", name: "A", prompt: "go", schedule: { interval: "15m" } }])
    const fake = fakeClient()
    await Promise.all([runTick(fake.client), runTick(fake.client)])
    expect(fake.created).toEqual([`A@${Global.Path.home}`])
    const config = await readConfig()
    expect(config.routines.routines[0]?.lastRun).toBeString()
    expect(config.routines.routines[0]?.recentRuns).toHaveLength(1)
  })

  test("runs in the routine's directory when set", async () => {
    await writeConfig([{ id: "a", name: "A", prompt: "go", directory: "/tmp/somewhere", schedule: { interval: "15m" } }])
    const fake = fakeClient()
    await runTick(fake.client)
    expect(fake.created).toEqual(["A@/tmp/somewhere"])
  })

  test("skips disabled routines", async () => {
    await writeConfig([{ id: "a", name: "A", prompt: "go", enabled: false, schedule: { interval: "15m" } }])
    const fake = fakeClient()
    await runTick(fake.client)
    expect(fake.created).toEqual([])
  })

  test("runs a targeted routine on the remote host and polls its status there", async () => {
    const target = targetServer({ ses_1: { type: "busy" } })
    try {
      await writeConfig([
        {
          id: "target-a",
          name: "A",
          prompt: "go",
          schedule: { interval: "15m" },
          target: { url: target.url, username: "opencode", password: "secret" },
        },
      ])
      const fake = fakeClient()
      await runTick(fake.client)
      // Session creation goes to the target and the local client is only the
      // tick's driver: the targeted run never touches it.
      expect(fake.created).toEqual([])
      expect(target.sessions).toEqual(["ses_1"])
      expect(fake.statusCalls).toEqual([])
      const config = await readConfig()
      expect(config.routines.routines[0]?.lastRun).toBeString()
      const recent = (config.routines.routines[0]?.recentRuns ?? []) as { state?: string; sessionID?: string }[]
      expect(recent[0]?.state).toBe("ok")
      expect(recent[0]?.sessionID).toBe("ses_1")
      const run = (await readRoutineRuns()).find((entry) => entry.routineId === "target-a")
      expect(run?.state).toBe("ok")
      expect(run?.sessionID).toBe("ses_1")
      // Credentials are sent to the target as a basic auth header and appear
      // nowhere in the error-free flow.
      const create = target.requests.find((request) => request.pathname === "/session")
      expect(create?.authorization).toBe(`Basic ${btoa("opencode:secret")}`)
      // The next tick's busy check polls the TARGET's /session/status, so a
      // targeted run in flight is not mistaken for a finished local one (which
      // would double-fire it). The local client is still never touched.
      await runTick(fake.client)
      expect(target.requests.some((request) => request.pathname === "/session/status")).toBe(true)
      expect(target.sessions).toEqual(["ses_1"])
      expect(fake.statusCalls).toEqual([])
      expect(((await readConfig()).routines.routines[0]?.recentRuns ?? [])).toHaveLength(1)
    } finally {
      target.stop()
    }
  })

  test("records an unreachable target as an error run and advances lastRun", async () => {
    await writeConfig([
      { id: "target-off", name: "B", prompt: "go", schedule: { interval: "1h" }, target: { url: "http://127.0.0.1:1" } },
    ])
    const fake = fakeClient()
    await runTick(fake.client)
    expect(fake.created).toEqual([])
    const config = await readConfig()
    expect(config.routines.routines[0]?.lastRun).toBeString()
    const recent = (config.routines.routines[0]?.recentRuns ?? []) as { state?: string; error?: string }[]
    expect(recent[0]?.state).toBe("error")
    expect(recent[0]?.error).toBeString()
    const run = (await readRoutineRuns()).find((entry) => entry.routineId === "target-off")
    expect(run?.state).toBe("error")
    expect(run?.error).toBeString()
  })
})
