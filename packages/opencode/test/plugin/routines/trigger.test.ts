import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { parseRoutines } from "../../../src/plugin/routines/parse"
import { triggerDue } from "../../../src/plugin/routines/trigger"

describe("triggerDue", () => {
  test("fires when a matched file changed since lastRun", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "notes.md")
    await Bun.write(file, "hello")
    const routine = {
      id: "w",
      name: "W",
      prompt: "go",
      enabled: true,
      lastRun: new Date(Date.now() - 60_000).toISOString(),
      trigger: { files: ["*.md"] },
    }
    expect(await triggerDue(routine, tmp.path)).toBe(true)
  })

  test("is quiet when nothing changed", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "notes.md")
    await Bun.write(file, "hello")
    const old = new Date(Date.now() - 60_000).toISOString()
    await Bun.file(file).stat().then(() => undefined)
    const routine = { id: "w", name: "W", prompt: "go", enabled: true, lastRun: new Date().toISOString(), trigger: { files: ["*.md"] } }
    expect(await triggerDue(routine, tmp.path)).toBe(false)
    expect(old).toBeDefined()
  })

  test("no trigger means not due", async () => {
    await using tmp = await tmpdir()
    expect(await triggerDue({ id: "w", name: "W", prompt: "go", enabled: true }, tmp.path)).toBe(false)
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
