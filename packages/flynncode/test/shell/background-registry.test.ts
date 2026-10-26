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
  return child
}

const sleeper = (detached: boolean) => launch("sleep", ["60"], detached)

const procStat = async (pid: number) => {
  const text = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
  return text
    ?.slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(" ")
}

const startOf = async (pid: number) => (await procStat(pid))?.[19]

// Running and not a zombie: a killed child of this runner may linger as a zombie until the runner reaps it.
const alive = async (pid: number) => {
  const state = (await procStat(pid))?.[0]
  return state !== undefined && state !== "Z"
}

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

const leaderGone = async (pid: number) => {
  while ((await procStat(pid)) !== undefined) await Bun.sleep(10)
}

// The surviving member of a group whose leader has exited.
const groupMember = async (pgid: number) => {
  const names = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name))
  const stats = await Promise.all(
    names.map(async (name) => ({ pid: Number(name), stat: await procStat(Number(name)) })),
  )
  const found = stats.find((item) => item.stat !== undefined && Number(item.stat[2]) === pgid)
  if (!found) throw new Error(`no member left in group ${pgid}`)
  return found.pid
}

const entry = (id: string, input?: Partial<BackgroundRegistry.Entry>): BackgroundRegistry.Entry => ({
  id,
  sessionID: "ses_1",
  pgid: 999_999,
  start: "1",
  startedAt: 1,
  command: "x",
  ...input,
})

const recorded = async (pgid: number, id = "bash_1") =>
  entry(id, { pgid, start: (await BackgroundRegistry.groupStart(pgid)) ?? "0" })

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
    expect(owner.start).toBe((await startOf(process.pid))!)
    expect(await BackgroundRegistry.owner()).toEqual(owner)
  })

  test("add, list and remove round-trip in this server's own file", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "state", "background-shells")
    expect(await BackgroundRegistry.list(dir)).toEqual([])
    await BackgroundRegistry.add(dir, entry("bash_1"))
    await BackgroundRegistry.add(dir, entry("bash_2", { pgid: 5 }))
    expect((await BackgroundRegistry.list(dir)).map((item) => item.id)).toEqual(["bash_1", "bash_2"])
    expect(await fs.readdir(dir)).toEqual([path.basename(await ownFile(dir))])
    expect(await readJson(await ownFile(dir))).toHaveLength(2)
    await BackgroundRegistry.remove(dir, "bash_1")
    expect(await BackgroundRegistry.list(dir)).toEqual([entry("bash_2", { pgid: 5 })])
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

  test("groupStart is the leader's /proc start time, or the earliest member's once the leader is gone", async () => {
    expect(await BackgroundRegistry.groupStart(999_999_999)).toBeUndefined()
    const child = await sleeper(true)
    expect(await BackgroundRegistry.groupStart(child.pid!)).toBe((await startOf(child.pid!))!)
    const leaderless = await launch("sh", ["-c", "sleep 300 >/dev/null 2>&1 &"], true)
    await leaderGone(leaderless.pid!)
    const member = await groupMember(leaderless.pid!)
    expect(await BackgroundRegistry.groupStart(leaderless.pid!)).toBe((await startOf(member))!)
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
    expect(await alive(first.pid!)).toBe(false)
    expect(await alive(second.pid!)).toBe(false)
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
    const start = await startOf(server.pid!)
    const theirs = await sleeper(true)
    const other = await deadOwner(dir, [await recorded(theirs.pid!, "bash_2")], `${server.pid}-${start}.json`)
    const result = await BackgroundRegistry.reap(dir)
    expect(result).toEqual({ killed: [], skipped: [] })
    expect(await alive(mine.pid!)).toBe(true)
    expect(await alive(theirs.pid!)).toBe(true)
    expect(await BackgroundRegistry.list(dir)).toHaveLength(1)
    expect(await readJson(other)).toHaveLength(1)
  })

  test("reap skips a recycled pgid whose leader has another start time and leaves it alone", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    // An unrelated group leader now holds the recorded pid.
    const child = await sleeper(true)
    const start = Number(await startOf(child.pid!))
    const calls: number[] = []
    const file = await deadOwner(dir, [entry("bash_1", { pgid: child.pid!, start: String(start - 1) })])
    const result = await BackgroundRegistry.reap(dir, { kill: (pgid) => void calls.push(pgid) })
    expect(result.killed).toEqual([])
    expect(result.skipped.map((item) => [item.id, item.reason])).toEqual([["bash_1", "not running"]])
    expect(calls).toEqual([])
    expect(await alive(child.pid!)).toBe(true)
    expect(await exists(file)).toBe(false)
  })

  test("reap kills a group whose leader has exited while a member lives on", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const child = await launch("sh", ["-c", "sleep 300 >/dev/null 2>&1 &"], true)
    // Read at once, as the service does, while the leader is normally still running.
    const item = await recorded(child.pid!)
    await leaderGone(child.pid!)
    const member = await groupMember(child.pid!)
    const file = await deadOwner(dir, [item])
    const result = await BackgroundRegistry.reap(dir)
    expect(result.killed.map((killed) => killed.id)).toEqual(["bash_1"])
    expect(await groupGone(child.pid!)).toBe(true)
    expect(await alive(member)).toBe(false)
    expect(await exists(file)).toBe(false)
  })

  test("reap skips a leaderless group whose members all predate the recorded start", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const child = await launch("sh", ["-c", "sleep 300 >/dev/null 2>&1 &"], true)
    await leaderGone(child.pid!)
    const member = await groupMember(child.pid!)
    const calls: number[] = []
    const later = String(Number(await startOf(member)) + 1)
    await deadOwner(dir, [entry("bash_1", { pgid: child.pid!, start: later })])
    const result = await BackgroundRegistry.reap(dir, { kill: (pgid) => void calls.push(pgid) })
    expect(result.skipped.map((item) => item.reason)).toEqual(["not running"])
    expect(calls).toEqual([])
    expect(await alive(member)).toBe(true)
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
      [entry("bash_2", { pgid: 1, start: (await startOf(1)) ?? "0" }), entry("bash_3", { pgid: 0 })],
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
      const start = await BackgroundRegistry.groupStart(pgid)
      await fs.writeFile(file, JSON.stringify([{ id: "bash_1", sessionID: "ses_1", pgid, start, startedAt: 1, command: "sh" }]))
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

  test("reap signals nothing when the recorded pid does not lead a process group", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    // Not detached: shares this test runner's process group, so no group has its pid as id.
    const child = await sleeper(false)
    const pid = child.pid!
    const calls: number[] = []
    await deadOwner(dir, [await recorded(pid)])
    const result = await BackgroundRegistry.reap(dir, { kill: (pgid) => void calls.push(pgid) })
    expect(result.killed).toEqual([])
    expect(result.skipped.map((item) => item.reason)).toEqual(["not running"])
    expect(calls).toEqual([])
    expect(await alive(pid)).toBe(true)
  })

  test("reap escalates to SIGKILL when the group ignores SIGTERM", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "background-shells")
    const child = await launch("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], true)
    const pid = child.pid!
    // Let the shell install its trap before the first signal arrives.
    await Bun.sleep(300)
    await deadOwner(dir, [await recorded(pid)])
    const result = await BackgroundRegistry.reap(dir)
    expect(result.killed).toHaveLength(1)
    expect(await alive(pid)).toBe(false)
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
    expect(await alive(other.pid!)).toBe(false)
    expect(await alive(denied.pid!)).toBe(true)
    expect((await readJson(file)).map((item: BackgroundRegistry.Entry) => item.id)).toEqual(["bash_1"])
  })
})
