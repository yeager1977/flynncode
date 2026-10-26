import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import fs from "fs/promises"
import path from "path"
import { BackgroundRegistry } from "../../src/shell/background/registry"
import { tmpdir } from "../fixture/fixture"

const spawned: ChildProcess[] = []

afterEach(() => {
  spawned.splice(0).forEach((child) => {
    if (child.pid === undefined) return
    // Detached children lead their own group; attached ones only own the pid.
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
    try {
      process.kill(child.pid, "SIGKILL")
    } catch {}
  })
})

const launch = async (command: string, args: string[], detached: boolean) => {
  const child = spawn(command, args, { detached, stdio: "ignore" })
  spawned.push(child)
  await new Promise((resolve) => child.once("spawn", resolve))
  // The spawn event can fire before exec completes, while /proc/<pid>/cmdline still reads empty.
  while ((await BackgroundRegistry.cmdline(child.pid!)) === undefined) await Bun.sleep(10)
  return child
}

const sleeper = (detached: boolean) => launch("sleep", ["60"], detached)

const alive = async (pid: number, cmdline: string) => (await BackgroundRegistry.cmdline(pid)) === cmdline

const entry = (id: string, input?: Partial<BackgroundRegistry.Entry>): BackgroundRegistry.Entry => ({
  id,
  sessionID: "ses_1",
  pid: 999_999,
  cmdline: "x",
  startedAt: 1,
  ...input,
})

describe("BackgroundRegistry", () => {
  test("add, list and remove round-trip", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "state", "background-shells.json")
    expect(await BackgroundRegistry.list(file)).toEqual([])
    await BackgroundRegistry.add(file, entry("bash_1"))
    await BackgroundRegistry.add(file, entry("bash_2", { pid: 5 }))
    expect((await BackgroundRegistry.list(file)).map((item) => item.id)).toEqual(["bash_1", "bash_2"])
    await BackgroundRegistry.remove(file, "bash_1")
    expect(await BackgroundRegistry.list(file)).toEqual([entry("bash_2", { pid: 5 })])
    await BackgroundRegistry.remove(file, "missing")
    expect((await BackgroundRegistry.list(file)).length).toBe(1)
  })

  test("concurrent adds and removes keep every entry", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "registry.json")
    await Promise.all(Array.from({ length: 25 }, (_, i) => BackgroundRegistry.add(file, entry(`bash_${i}`))))
    expect(await BackgroundRegistry.list(file)).toHaveLength(25)
    await Promise.all(Array.from({ length: 10 }, (_, i) => BackgroundRegistry.remove(file, `bash_${i * 2}`)))
    const ids = (await BackgroundRegistry.list(file)).map((item) => item.id)
    expect(ids).toHaveLength(15)
    expect(ids).not.toContain("bash_0")
    expect(ids).toContain("bash_1")
  })

  test("a corrupt or non-array file reads as empty", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "registry.json")
    await fs.writeFile(file, "{not json")
    expect(await BackgroundRegistry.list(file)).toEqual([])
    await fs.writeFile(file, JSON.stringify({ id: "bash_1" }))
    expect(await BackgroundRegistry.list(file)).toEqual([])
    await BackgroundRegistry.add(file, entry("bash_1"))
    expect(await BackgroundRegistry.list(file)).toHaveLength(1)
  })

  test("cmdline reads /proc with NULs as spaces", async () => {
    expect(await BackgroundRegistry.cmdline(process.pid)).toContain("bun")
    expect(await BackgroundRegistry.cmdline(999_999_999)).toBeUndefined()
    const child = await sleeper(true)
    expect(await BackgroundRegistry.cmdline(child.pid!)).toBe("sleep 60")
  })

  test("reap kills the recorded process group and empties the registry", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "registry.json")
    const child = await sleeper(true)
    const pid = child.pid!
    const cmdline = (await BackgroundRegistry.cmdline(pid))!
    await BackgroundRegistry.add(file, entry("bash_1", { pid, cmdline }))
    const result = await BackgroundRegistry.reap(file)
    expect(result.killed.map((item) => item.id)).toEqual(["bash_1"])
    expect(result.skipped).toEqual([])
    expect(await alive(pid, cmdline)).toBe(false)
    expect(await BackgroundRegistry.list(file)).toEqual([])
  })

  test("reap skips an entry whose cmdline does not match and leaves the process alone", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "registry.json")
    const cmdline = (await BackgroundRegistry.cmdline(process.pid))!
    const calls: number[] = []
    await BackgroundRegistry.add(file, entry("bash_1", { pid: process.pid, cmdline: "something else" }))
    const result = await BackgroundRegistry.reap(file, { kill: (pgid) => void calls.push(pgid) })
    expect(result.killed).toEqual([])
    expect(result.skipped.map((item) => item.id)).toEqual(["bash_1"])
    expect(calls).toEqual([])
    expect(await alive(process.pid, cmdline)).toBe(true)
    expect(await BackgroundRegistry.list(file)).toEqual([])
  })

  test("reap never kills the current process, its parent, or pid 1 even when the cmdline matches", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "registry.json")
    const calls: number[] = []
    const targets = await Promise.all(
      [process.pid, process.ppid, 1, 0].map(async (pid, i) =>
        entry(`bash_${i}`, { pid, cmdline: (await BackgroundRegistry.cmdline(pid)) ?? "n/a" }),
      ),
    )
    await Promise.all(targets.map((item) => BackgroundRegistry.add(file, item)))
    const result = await BackgroundRegistry.reap(file, { kill: (pgid) => void calls.push(pgid) })
    expect(result.killed).toEqual([])
    expect(result.skipped).toHaveLength(4)
    expect(calls).toEqual([])
  })

  test("reap kills only the pid, never a group, when the pid is not a group leader", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "registry.json")
    // Not detached: shares this test runner's process group, so a group kill would hit the runner.
    const child = await sleeper(false)
    const pid = child.pid!
    const cmdline = (await BackgroundRegistry.cmdline(pid))!
    const calls: number[] = []
    await BackgroundRegistry.add(file, entry("bash_1", { pid, cmdline }))
    const result = await BackgroundRegistry.reap(file, { kill: (pgid) => void calls.push(pgid) })
    expect(result.killed.map((item) => item.id)).toEqual(["bash_1"])
    expect(calls).toEqual([])
    expect(await alive(pid, cmdline)).toBe(false)
  })

  test("reap escalates to SIGKILL when the group ignores SIGTERM", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "registry.json")
    const child = await launch("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], true)
    const pid = child.pid!
    // Let the shell install its trap before the first signal arrives.
    await Bun.sleep(300)
    const cmdline = (await BackgroundRegistry.cmdline(pid))!
    await BackgroundRegistry.add(file, entry("bash_1", { pid, cmdline }))
    const result = await BackgroundRegistry.reap(file)
    expect(result.killed).toHaveLength(1)
    expect(await alive(pid, cmdline)).toBe(false)
  })
})
