import { describe, expect, test } from "bun:test"
import type { SidecarSyncCommand } from "./sidecar-sync"
import { restartDecision, superviseSidecar } from "./sidecar-supervisor"

const minute = 60_000

describe("restartDecision", () => {
  test("restarts after an abnormal exit, starting with a short delay", () => {
    expect(restartDecision({ code: 133, stopping: false, restarts: [], now: 0 })).toEqual({
      restart: true,
      delayMs: 1_000,
    })
  })

  test("does not restart a sidecar that was asked to stop", () => {
    expect(restartDecision({ code: 133, stopping: true, restarts: [], now: 0 })).toEqual({
      restart: false,
      reason: "stopped",
    })
  })

  test("does not restart a clean exit", () => {
    expect(restartDecision({ code: 0, stopping: false, restarts: [], now: 0 })).toEqual({
      restart: false,
      reason: "clean-exit",
    })
  })

  test("backs off with each recent restart, up to a cap", () => {
    const delays = [0, 1, 2, 3, 4].map(
      (count) =>
        restartDecision({ code: 133, stopping: false, restarts: Array(count).fill(0), now: 1_000 }) as {
          delayMs: number
        },
    )
    expect(delays.map((decision) => decision.delayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000])
  })

  test("gives up when the sidecar keeps crashing within the window", () => {
    expect(restartDecision({ code: 133, stopping: false, restarts: Array(5).fill(0), now: minute })).toEqual({
      restart: false,
      reason: "crash-loop",
    })
  })

  test("forgets restarts that are older than the window", () => {
    expect(restartDecision({ code: 133, stopping: false, restarts: Array(5).fill(0), now: 11 * minute })).toEqual({
      restart: true,
      delayMs: 1_000,
    })
  })
})

type FakeSidecar = {
  stopped: boolean
  posted: SidecarSyncCommand[]
  exit: (code: number) => void
}

function harness(options: { failStarts?: number[]; holdStart?: number } = {}) {
  const sidecars: FakeSidecar[] = []
  const events: string[] = []
  const sleeps: Array<{ ms: number; resolve: () => void }> = []
  let starts = 0
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const start = async (onExit: (code: number) => void) => {
    const index = starts++
    if (options.failStarts?.includes(index)) throw new Error(`start ${index} failed`)
    if (index === options.holdStart) await held
    const sidecar: FakeSidecar = { stopped: false, posted: [], exit: onExit }
    sidecars.push(sidecar)
    return {
      listener: {
        stop: async () => {
          sidecar.stopped = true
        },
      },
      health: { wait: Promise.resolve() },
      post: (command: SidecarSyncCommand) => {
        sidecar.posted.push(command)
        return true
      },
    }
  }
  const supervise = () =>
    superviseSidecar(start, {
      now: () => 0,
      sleep: (ms) => new Promise<void>((resolve) => sleeps.push({ ms, resolve })),
      onRestart: (info) => events.push(`restart ${info.attempt} after ${info.code}`),
      onRestartFailed: () => events.push("restart failed"),
      onGiveUp: (info) => events.push(`give up: ${info.reason}`),
    })
  return { sidecars, events, sleeps, supervise, release, starts: () => starts }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const sync: SidecarSyncCommand = { type: "sync-now", requestID: "r1" }

describe("superviseSidecar", () => {
  test("starts a replacement after the sidecar dies and routes commands to it", async () => {
    const h = harness()
    const supervised = await h.supervise()
    expect(supervised.post(sync)).toBe(true)

    h.sidecars[0].exit(133)
    await settle()
    // Commands sent while the replacement is still starting are dropped, as before the first start.
    expect(supervised.post(sync)).toBe(false)

    h.sleeps[0].resolve()
    await settle()

    expect(h.starts()).toBe(2)
    expect(h.events).toEqual(["restart 1 after 133"])
    expect(h.sleeps.map((sleep) => sleep.ms)).toEqual([1_000])
    expect(supervised.post(sync)).toBe(true)
    expect(h.sidecars[1].posted).toEqual([sync])
    expect(h.sidecars[0].posted).toEqual([sync])
  })

  test("keeps supervising the replacement", async () => {
    const h = harness()
    await h.supervise()

    h.sidecars[0].exit(133)
    await settle()
    h.sleeps[0].resolve()
    await settle()
    h.sidecars[1].exit(133)
    await settle()
    h.sleeps[1].resolve()
    await settle()

    expect(h.starts()).toBe(3)
    expect(h.sleeps.map((sleep) => sleep.ms)).toEqual([1_000, 2_000])
  })

  test("does not restart after stop", async () => {
    const h = harness()
    const supervised = await h.supervise()

    await supervised.listener.stop()
    h.sidecars[0].exit(0)
    await settle()

    expect(h.sidecars[0].stopped).toBe(true)
    expect(h.starts()).toBe(1)
    expect(h.sleeps).toEqual([])
  })

  test("does not restart an exit that happens while stopping, even when abnormal", async () => {
    const h = harness()
    const supervised = await h.supervise()

    await supervised.listener.stop()
    h.sidecars[0].exit(137)
    await settle()

    expect(h.starts()).toBe(1)
    expect(h.events).toEqual([])
  })

  test("does not restart a clean exit", async () => {
    const h = harness()
    await h.supervise()

    h.sidecars[0].exit(0)
    await settle()

    expect(h.starts()).toBe(1)
    expect(h.events).toEqual(["give up: clean-exit"])
  })

  test("drops the pending restart when stop arrives during the backoff", async () => {
    const h = harness()
    const supervised = await h.supervise()

    h.sidecars[0].exit(133)
    await settle()
    await supervised.listener.stop()
    h.sleeps[0].resolve()
    await settle()

    expect(h.starts()).toBe(1)
  })

  test("stops a replacement that finished starting after stop was requested", async () => {
    const h = harness({ holdStart: 1 })
    const supervised = await h.supervise()

    h.sidecars[0].exit(133)
    await settle()
    h.sleeps[0].resolve()
    await settle()
    // The replacement is mid-start (held open); stop arrives before it can be adopted.
    expect(h.starts()).toBe(2)
    await supervised.listener.stop()
    h.release()
    await settle()

    expect(h.sidecars[1].stopped).toBe(true)
    expect(supervised.post(sync)).toBe(false)
  })

  test("does not retry a first start that fails", async () => {
    const h = harness({ failStarts: [0] })

    await expect(h.supervise()).rejects.toThrow("start 0 failed")

    expect(h.starts()).toBe(1)
    expect(h.sleeps).toEqual([])
  })

  test("keeps retrying a replacement that fails to start, then gives up", async () => {
    const h = harness({ failStarts: [1, 2, 3, 4, 5, 6, 7] })
    await h.supervise()

    h.sidecars[0].exit(133)
    // Restarts 1-5 each fail to start; the sixth attempt is refused as a crash loop.
    for (let attempt = 0; attempt < 5; attempt++) {
      await settle()
      h.sleeps[attempt].resolve()
    }
    await settle()

    expect(h.starts()).toBe(6)
    expect(h.sleeps.map((sleep) => sleep.ms)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000])
    expect(h.events.filter((event) => event === "restart failed")).toHaveLength(5)
    expect(h.events.at(-1)).toBe("give up: crash-loop")
  })

  test("reports the health wait of the first start", async () => {
    const h = harness()
    const supervised = await h.supervise()

    await expect(supervised.health.wait).resolves.toBeUndefined()
  })
})
