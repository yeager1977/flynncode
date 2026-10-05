import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Preview } from "../../src/preview/preview"
import { TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(LayerNode.compile(Preview.node))

// A static file server that reads its port from $PORT (set by the preview
// service) and serves one HTML page with a title.
const SERVER_SCRIPT = `
const port = Number(process.env.PORT ?? 0)
const server = Bun.serve({
  port,
  fetch: () =>
    new Response("<html><head><title>ok page</title></head><body>hello</body></html>", {
      headers: { "content-type": "text/html" },
    }),
})
process.on("SIGTERM", () => {
  server.stop(true)
  process.exit(0)
})
`

function pollState(name: string, states: ("running" | "stopped" | "starting" | "failed")[]) {
  return pollWithTimeout(
    Effect.gen(function* () {
      const preview = yield* Preview.Service
      const info = (yield* preview.list()).find((server) => server.name === name)
      return info && states.includes(info.state) ? info : undefined
    }),
    `preview server "${name}" never reached one of: ${states.join(", ")}`,
    "30 seconds",
  )
}

describe("Preview lifecycle", () => {
  it.instance(
    "start/stop/restart a bun-served static file and stop kills the process",
    () =>
      Effect.gen(function* () {
        const preview = yield* Preview.Service
        const servers = yield* preview.list()
        expect(servers.map((server) => server.name)).toEqual(["static"])
        expect(servers[0].state).toBe("stopped")

        const started = yield* preview.start("static")
        expect(started.state).toBe("starting")
        expect(started.pid).toBeGreaterThan(0)
        expect(started.url).toMatch(/^http:\/\/localhost:\d+\/$/)

        const running = yield* pollState("static", ["running"])
        expect(running?.port).toBeGreaterThan(0)

        // The served page verifies over HTTP with title extraction.
        const verified = yield* preview.verify("static")
        expect(verified.httpStatus).toBe(200)
        expect(verified.title).toBe("ok page")
        expect(verified.errorCount).toBe(0)

        const stopped = yield* preview.stop("static")
        expect(stopped.state).toBe("stopped")
        const exited = yield* pollWithTimeout(
          Effect.gen(function* () {
            const pid = stopped.pid
            if (pid === undefined) return true
            const alive = yield* Effect.callback<boolean>((resume) => {
              const check = Bun.spawnSync(["bash", "-c", `ps -p ${pid} > /dev/null 2>&1`])
              resume(Effect.succeed(check.exitCode === 0))
            })
            return alive ? undefined : true
          }),
          "preview server process still alive after stop",
          "10 seconds",
        )
        expect(exited).toBe(true)

        // Restart brings it back on a fresh port.
        const restarted = yield* preview.restart("static")
        expect(restarted.state).toBe("starting")
        const runningAgain = yield* pollState("static", ["running"])
        expect(runningAgain?.pid).not.toBe(stopped.pid)
        const verifiedAgain = yield* preview.verify("static")
        expect(verifiedAgain.httpStatus).toBe(200)
        yield* preview.stop("static")
      }),
    {
      config: {
        preview: { servers: [{ name: "static", command: "bun", args: ["server.ts"], autoPort: true }] },
      } as never,
      init: (directory) =>
        Effect.promise(() => Bun.write(`${directory}/server.ts`, SERVER_SCRIPT)),
    },
  )

  it.instance(
    "start fails diagnosably for an unknown server",
    () =>
      Effect.gen(function* () {
        const preview = yield* Preview.Service
        const failure = yield* Effect.flip(preview.start("missing"))
        expect(failure.message).toContain("No preview server named")
      }),
    {
      config: { preview: { servers: [{ name: "static", command: "bun", args: [], autoPort: true }] } } as never,
    },
  )

  it.instance(
    "verify is inert when no server is running",
    () =>
      Effect.gen(function* () {
        const preview = yield* Preview.Service
        const failure = yield* Effect.flip(preview.verify())
        expect(failure.message).toContain("No preview server is running")
      }),
    {
      config: { preview: { servers: [{ name: "static", command: "bun", args: [] }] } } as never,
    },
  )
})