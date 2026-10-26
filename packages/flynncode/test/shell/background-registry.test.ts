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

const groupGone = async (pgid: number) => {
  const deadline = Date.now() + 1_000
  const probe = () => {
    try {
      process.kill(-pgid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
    }
  }
  while (!probe() && Date.now() < deadline) await Bun.sleep(20)
  return probe()
}

const entry = (id: string, input?: Partial<BackgroundRegistry.Entry>): BackgroundRegistry.Entry => ({
  id,
  sessionID: "ses_1",
  pid: 999_999,
  cmdline: "x",
  startedAt: 1,
  ...input,
})

const recorded = async (pid: number, id = "bash_1") =>
  entry(id, { pid, cmdline: (await BackgroundRegistry.cmdline(pid)) ?? "n/a" })

// A file left by a server that is gone: pid above pid_max, so nothing can be running under it.
const deadOwner = async (dir: string, entries: BackgroundRegistry.Entry[], name = "999999999-1.json") => {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), JSON.stringify(entries))
  return path.join(dir, name)
}

const ownFile = async (dir: string) => {
  const owner = await BackgroundRegistry.owner()
  return path.join(dir, `${owner.pid}-${owner.start}.json`)
}

const exists = (file: string) => Bun.file(file).exists()

const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"))

describe("BackgroundRegistry", () => {
  test("the owner is this process, identified by its /proc start time", async () => {
    const owner = await BackgroundRegistry.owner()
    expect(owner.pid).toBe(process.pid)
    const stat = await fs.readFile(`/proc/${process.pid}/stat`, "utf8")
    expect(owner.start).toBe(
      stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(" ")[19],
    )
    expect(await BackgroundRegistry.owner()).toEqual(owner)
  })

  test("add, list and remove round-trip in this server's own file", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "state", "background-shells")
    expect(await BackgroundRegistry.list(dir)).toEqual([])
    await BackgroundRegistry.add(dir, entry("bash_1"))
    await BackgroundRegistry.add(dir, entry("bash_2", { pid: 5 }))
    expect((await BackgroundRegistry.list(dir)).map((item) => item.id)).toEqual(["bash_1", "bash_2"])
    expect(await fs.readdir(dir)).toEqual([path.basename(await ownFile(dir))])
    expect(await readJson(await ownFile(dir))).toHaveLength(2)
    await BackgroundRegistry.remove(dir, "bash_1")
    expect(await BackgroundRegistry.list(dir)).toEqual([entry("bash_2", { pid: 5 })])
    await BackgroundRegistry.remove(dir, "missing")
    expect((await BackgroundRegistry.list(dir)).length).toBe(1)
  })

  test("list ignores other servers' files", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    await deadOwner(dir, [entry("bash_9")])
    expect(await BackgroundRegistry.list(dir)).toEqual([])
  })

  test("concurrent adds and removes keep every entry", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    await Promise.all(Array.from({ length: 25 }, (_, i) => BackgroundRegistry.add(dir, entry(`bash_${i}`))))
    expect(await BackgroundRegistry.list(dir)).toHaveLength(25)
    await Promise.all(Array.from({ length: 10 }, (_, i) => BackgroundRegistry.remove(dir, `bash_${i * 2}`)))
    const ids = (await BackgroundRegistry.list(dir)).map((item) => item.id)
    expect(ids).toHaveLength(15)
    expect(ids).not.toContain("bash_0")
    expect(ids).toContain("bash_1")
  })

  test("an unreadable file lists as empty but is never overwritten", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const file = await ownFile(dir)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, "{not json")
    expect(await BackgroundRegistry.list(dir)).toEqual([])
    await expect(BackgroundRegistry.add(dir, entry("bash_1"))).rejects.toThrow()
    await expect(BackgroundRegistry.remove(dir, "bash_1")).rejects.toThrow()
    await BackgroundRegistry.list(dir)
    expect(await fs.readFile(file, "utf8")).toBe("{not json")

    await fs.writeFile(file, JSON.stringify({ id: "bash_1" }))
    expect(await BackgroundRegistry.list(dir)).toEqual([])
    await expect(BackgroundRegistry.add(dir, entry("bash_1"))).rejects.toThrow()
    await BackgroundRegistry.list(dir)
    expect(await readJson(file)).toEqual({ id: "bash_1" })

    await fs.rm(file)
    await fs.mkdir(file)
    expect(await BackgroundRegistry.list(dir)).toEqual([])
    await expect(BackgroundRegistry.add(dir, entry("bash_1"))).rejects.toThrow()
    await BackgroundRegistry.list(dir)
    expect((await fs.stat(file)).isDirectory()).toBe(true)
  })

  test("cmdline reads /proc with NULs as spaces", async () => {
    expect(await BackgroundRegistry.cmdline(process.pid)).toContain("bun")
    expect(await BackgroundRegistry.cmdline(999_999_999)).toBeUndefined()
    const child = await sleeper(true)
    expect(await BackgroundRegistry.cmdline(child.pid!)).toBe("sleep 60")
  })

  test("reap kills groups recorded by dead servers and deletes their files", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const first = await sleeper(true)
    const second = await sleeper(true)
    const gone = await deadOwner(dir, [await recorded(first.pid!)])
    // Same pid as this process but another start time: a previous server whose pid was recycled.
    const recycled = await deadOwner(dir, [await recorded(second.pid!, "bash_2")], `${process.pid}-1.json`)
    const result = await BackgroundRegistry.reap(dir)
    expect(result.killed.map((item) => item.id).sort()).toEqual(["bash_1", "bash_2"])
    expect(result.skipped).toEqual([])
    expect(await alive(first.pid!, "sleep 60")).toBe(false)
    expect(await alive(second.pid!, "sleep 60")).toBe(false)
    expect(await exists(gone)).toBe(false)
    expect(await exists(recycled)).toBe(false)
  })

  test("reap never touches files of live servers, including its own", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const mine = await sleeper(true)
    await BackgroundRegistry.add(dir, await recorded(mine.pid!))
    // Another running server, named with its real start time.
    const server = await sleeper(true)
    const stat = await fs.readFile(`/proc/${server.pid}/stat`, "utf8")
    const start = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(" ")[19]
    const theirs = await sleeper(true)
    const other = await deadOwner(dir, [await recorded(theirs.pid!, "bash_2")], `${server.pid}-${start}.json`)
    const result = await BackgroundRegistry.reap(dir)
    expect(result).toEqual({ killed: [], skipped: [] })
    expect(await alive(mine.pid!, "sleep 60")).toBe(true)
    expect(await alive(theirs.pid!, "sleep 60")).toBe(true)
    expect(await BackgroundRegistry.list(dir)).toHaveLength(1)
    expect(await readJson(other)).toHaveLength(1)
  })

  test("reap skips an entry whose cmdline does not match and leaves the process alone", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const cmdline = (await BackgroundRegistry.cmdline(process.pid))!
    const calls: number[] = []
    const file = await deadOwner(dir, [entry("bash_1", { pid: process.pid, cmdline: "something else" })])
    const result = await BackgroundRegistry.reap(dir, { kill: (pgid) => void calls.push(pgid) })
    expect(result.killed).toEqual([])
    expect(result.skipped.map((item) => [item.id, item.reason])).toEqual([["bash_1", "not running"]])
    expect(calls).toEqual([])
    expect(await alive(process.pid, cmdline)).toBe(true)
    expect(await exists(file)).toBe(false)
  })

  test("reap never kills the current process or its parent and keeps their records", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const calls: number[] = []
    const protectedFile = await deadOwner(dir, [
      await recorded(process.pid, "bash_0"),
      await recorded(process.ppid, "bash_1"),
    ])
    const invalid = await deadOwner(
      dir,
      [
        entry("bash_2", { pid: 1, cmdline: (await BackgroundRegistry.cmdline(1)) ?? "n/a" }),
        entry("bash_3", { pid: 0 }),
      ],
      "999999998-1.json",
    )
    const result = await BackgroundRegistry.reap(dir, { kill: (pgid) => void calls.push(pgid) })
    expect(result.killed).toEqual([])
    expect(result.skipped).toHaveLength(4)
    expect(calls).toEqual([])
    expect((await readJson(protectedFile)).map((item: BackgroundRegistry.Entry) => item.id)).toEqual([
      "bash_0",
      "bash_1",
    ])
    expect(await exists(invalid)).toBe(false)
  })

  test("reap never signals its own process group", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const registry = path.resolve(import.meta.dir, "../../src/shell/background/registry.ts")
    // Runs under sh -> sh -> bun, so the recorded group leader is neither the reaper nor its parent.
    const script = `
      import { BackgroundRegistry } from ${JSON.stringify(registry)}
      import fs from "fs/promises"
      const stat = await fs.readFile("/proc/self/stat", "utf8")
      const pgid = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[2])
      const dir = process.env.REAP_DIR
      const file = dir + "/999999999-1.json"
      await fs.mkdir(dir, { recursive: true })
      const cmdline = await BackgroundRegistry.cmdline(pgid)
      await fs.writeFile(file, JSON.stringify([{ id: "bash_1", sessionID: "ses_1", pid: pgid, cmdline, startedAt: 1 }]))
      const calls = []
      const result = await BackgroundRegistry.reap(dir, { kill: (group, signal) => calls.push([group, signal]) })
      console.log(JSON.stringify({ pgid, pid: process.pid, ppid: process.ppid, calls, result, kept: await Bun.file(file).exists() }))
    `
    const child = spawn("sh", ["-c", `sh -c '"$REAP_BUN" -e "$REAP_SCRIPT"; :'; :`], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, REAP_BUN: process.execPath, REAP_SCRIPT: script, REAP_DIR: dir },
    })
    spawned.push(child)
    const chunks: Buffer[] = []
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk))
    await new Promise((resolve) => child.once("exit", resolve))
    const output = JSON.parse(Buffer.concat(chunks).toString())
    expect(output.pgid).toBe(child.pid)
    expect(output.pgid).not.toBe(output.pid)
    expect(output.pgid).not.toBe(output.ppid)
    expect(output.calls).toEqual([])
    expect(output.result.killed).toEqual([])
    expect(output.result.skipped.map((item: { reason: string }) => item.reason)).toEqual(["own process group"])
    expect(output.kept).toBe(true)
  })

  test("reap kills only the pid, never a group, when the pid is not a group leader", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    // Not detached: shares this test runner's process group, so a group kill would hit the runner.
    const child = await sleeper(false)
    const pid = child.pid!
    const calls: number[] = []
    await deadOwner(dir, [await recorded(pid)])
    const result = await BackgroundRegistry.reap(dir, { kill: (pgid) => void calls.push(pgid) })
    expect(result.killed.map((item) => item.id)).toEqual(["bash_1"])
    expect(calls).toEqual([])
    expect(await alive(pid, "sleep 60")).toBe(false)
  })

  test("reap escalates to SIGKILL when the group ignores SIGTERM", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const child = await launch("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], true)
    const pid = child.pid!
    // Let the shell install its trap before the first signal arrives.
    await Bun.sleep(300)
    const item = await recorded(pid)
    await deadOwner(dir, [item])
    const result = await BackgroundRegistry.reap(dir)
    expect(result.killed).toHaveLength(1)
    expect(await alive(pid, item.cmdline)).toBe(false)
    expect(await groupGone(pid)).toBe(true)
  })

  test("reap kills group members that ignore SIGTERM after the leader has exited", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const child = await launch("bash", ["-c", "(trap '' TERM; exec sleep 97) & wait"], true)
    const pid = child.pid!
    await Bun.sleep(300)
    await deadOwner(dir, [await recorded(pid)])
    const result = await BackgroundRegistry.reap(dir)
    expect(result.killed).toHaveLength(1)
    expect(await groupGone(pid)).toBe(true)
  })

  test("an error on one entry is recorded, the sweep continues, and the file keeps only unresolved entries", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const denied = await sleeper(true)
    const other = await sleeper(true)
    const file = await deadOwner(dir, [await recorded(denied.pid!, "bash_1"), await recorded(other.pid!, "bash_2")])
    const result = await BackgroundRegistry.reap(dir, {
      kill: (pgid, signal) => {
        if (pgid === denied.pid) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
        process.kill(-pgid, signal)
      },
    })
    expect(result.killed.map((item) => item.id)).toEqual(["bash_2"])
    expect(result.skipped.map((item) => item.id)).toEqual(["bash_1"])
    expect(result.skipped[0].reason).toContain("EPERM")
    expect(await alive(other.pid!, "sleep 60")).toBe(false)
    expect(await alive(denied.pid!, "sleep 60")).toBe(true)
    expect((await readJson(file)).map((item: BackgroundRegistry.Entry) => item.id)).toEqual(["bash_1"])
  })
})
