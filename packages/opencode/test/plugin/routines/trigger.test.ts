import { describe, expect, test } from "bun:test"
import { utimes } from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { parseRoutines, type Routine } from "../../../src/plugin/routines/parse"
import { fileTriggersDue } from "../../../src/plugin/routines/trigger"

const watcher = (directory: string, patch: Partial<Routine> = {}): Routine => ({
  id: "w",
  name: "W",
  prompt: "go",
  enabled: true,
  directory,
  trigger: { files: ["*.md"] },
  ...patch,
})

async function touch(file: string, at: Date) {
  await Bun.write(file, at.toISOString())
  await utimes(file, at, at)
}

describe("fileTriggersDue", () => {
  test("records a baseline on first sight instead of firing", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state.json")
    await touch(path.join(tmp.path, "notes.md"), new Date(Date.now() - 60_000))
    expect(await fileTriggersDue([watcher(tmp.path)], new Set(), state)).toEqual([])
    expect(await fileTriggersDue([watcher(tmp.path)], new Set(), state)).toEqual([])
  })

  test("fires once when a matched file changes after the baseline", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state.json")
    const file = path.join(tmp.path, "notes.md")
    await touch(file, new Date(Date.now() - 60_000))
    await fileTriggersDue([watcher(tmp.path)], new Set(), state)
    await touch(file, new Date())
    expect((await fileTriggersDue([watcher(tmp.path)], new Set(), state)).map((routine) => routine.id)).toEqual(["w"])
    expect(await fileTriggersDue([watcher(tmp.path)], new Set(), state)).toEqual([])
  })

  test("absorbs changes made while the routine's own run is busy", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state.json")
    const file = path.join(tmp.path, "notes.md")
    await touch(file, new Date(Date.now() - 60_000))
    await fileTriggersDue([watcher(tmp.path)], new Set(), state)
    await touch(file, new Date())
    expect(await fileTriggersDue([watcher(tmp.path)], new Set(["w"]), state)).toEqual([])
    expect(await fileTriggersDue([watcher(tmp.path)], new Set(), state)).toEqual([])
  })

  test("** matches nested files", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state.json")
    const file = path.join(tmp.path, "docs", "deep", "notes.md")
    const routine = watcher(tmp.path, { trigger: { files: ["docs/**/*.md"] } })
    await touch(file, new Date(Date.now() - 60_000))
    await fileTriggersDue([routine], new Set(), state)
    await touch(file, new Date())
    expect((await fileTriggersDue([routine], new Set(), state)).map((entry) => entry.id)).toEqual(["w"])
  })

  test("disabled routines never fire", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state.json")
    const file = path.join(tmp.path, "notes.md")
    const routine = watcher(tmp.path, { enabled: false })
    await touch(file, new Date(Date.now() - 60_000))
    await fileTriggersDue([routine], new Set(), state)
    await touch(file, new Date())
    expect(await fileTriggersDue([routine], new Set(), state)).toEqual([])
  })

  test("routines without a directory are skipped", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state.json")
    expect(await fileTriggersDue([watcher(tmp.path, { directory: undefined })], new Set(), state)).toEqual([])
  })

  test("github trigger requires owner, repo, and event", () => {
    const bad = parseRoutines({
      routines: [{ id: "g", name: "G", prompt: "go", trigger: { github: { owner: "o" } } }],
    })
    expect(bad.ok).toBe(false)
    const good = parseRoutines({
      routines: [{ id: "g", name: "G", prompt: "go", trigger: { github: { owner: "o", repo: "r", event: "pr" } } }],
    })
    expect(good.ok).toBe(true)
  })
})
