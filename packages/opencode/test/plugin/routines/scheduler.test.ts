import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "fs/promises"
import path from "path"
import { parse } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import type { PluginInput } from "@opencode-ai/plugin"
import { loadRoutines, markRan, runTick } from "../../../src/plugin/routines/index"

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
  const client = {
    session: {
      create: async (input: { body: { title: string }; query: { directory: string } }) => {
        created.push(`${input.body.title}@${input.query.directory}`)
        return { data: { id: `ses_${created.length}` } }
      },
      promptAsync: async () => ({ data: undefined }),
      status: async () => ({ data: {} }),
    },
  }
  // Only the session calls the scheduler makes are needed here.
  return { created, client: client as unknown as PluginInput["client"] }
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
})
