import { describe, expect, test } from "bun:test"
import mobileGateway from "../src/index"
import { stopGateway } from "../src/gateway"

const input = {
  client: {} as never,
  project: {} as never,
  directory: "/tmp",
  worktree: "/tmp",
  serverUrl: new URL("http://127.0.0.1:4096"),
  $: undefined as never,
  experimental_workspace: { register() {} },
}

describe("plugin entry", () => {
  test("exposes an id and a server function", () => {
    expect(mobileGateway.id).toBe("@flynncode/mobile-gateway")
    expect(typeof mobileGateway.server).toBe("function")
  })

  test("returns hooks without throwing when the password is unset", async () => {
    const previous = process.env.OPENCODE_SERVER_PASSWORD
    delete process.env.OPENCODE_SERVER_PASSWORD
    const hooks = await mobileGateway.server(input)
    expect(typeof hooks).toBe("object")
    await hooks.dispose?.()
    if (previous !== undefined) process.env.OPENCODE_SERVER_PASSWORD = previous
  })

  test("starts a gateway when the password is set and closes it on dispose", async () => {
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousPort = process.env.OPENCODE_MOBILE_PORT
    const previousUpstream = process.env.OPENCODE_MOBILE_UPSTREAM
    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    process.env.OPENCODE_MOBILE_PORT = "0"
    process.env.OPENCODE_MOBILE_UPSTREAM = "http://127.0.0.1:4096"

    const hooks = await mobileGateway.server(input)

    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
    if (previousPort === undefined) delete process.env.OPENCODE_MOBILE_PORT
    else process.env.OPENCODE_MOBILE_PORT = previousPort
    if (previousUpstream === undefined) delete process.env.OPENCODE_MOBILE_UPSTREAM
    else process.env.OPENCODE_MOBILE_UPSTREAM = previousUpstream

    expect(hooks).toBeDefined()
    expect(hooks.dispose).toBeInstanceOf(Function)
    await hooks.dispose?.()
    stopGateway()
  })

  test("still returns hooks when the port is already taken", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") })
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousPort = process.env.OPENCODE_MOBILE_PORT
    const previousHost = process.env.OPENCODE_MOBILE_HOST
    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    process.env.OPENCODE_MOBILE_HOST = "127.0.0.1"
    process.env.OPENCODE_MOBILE_PORT = String(blocker.port)

    const hooks = await mobileGateway.server(input)

    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
    if (previousPort === undefined) delete process.env.OPENCODE_MOBILE_PORT
    else process.env.OPENCODE_MOBILE_PORT = previousPort
    if (previousHost === undefined) delete process.env.OPENCODE_MOBILE_HOST
    else process.env.OPENCODE_MOBILE_HOST = previousHost

    expect(hooks).toEqual({})
    blocker.stop(true)
  })

  test("proxies to the serverUrl upstream when OPENCODE_MOBILE_UPSTREAM is unset", async () => {
    // Pin a known-free port: bind ephemeral, read it, release it for the gateway.
    const pin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("pin") })
    const gatewayPort = pin.port
    pin.stop(true)

    const requests: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requests.push(new URL(request.url).pathname)
        return new Response("task-4-upstream-ok", { headers: { "content-type": "text/plain" } })
      },
    })

    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousMobile = process.env.OPENCODE_MOBILE_PASSWORD
    const previousUpstream = process.env.OPENCODE_MOBILE_UPSTREAM
    const previousHost = process.env.OPENCODE_MOBILE_HOST
    const previousPort = process.env.OPENCODE_MOBILE_PORT

    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    process.env.OPENCODE_MOBILE_PASSWORD = "phone"
    process.env.OPENCODE_MOBILE_HOST = "127.0.0.1"
    process.env.OPENCODE_MOBILE_PORT = String(gatewayPort)
    delete process.env.OPENCODE_MOBILE_UPSTREAM

    const hooks = await mobileGateway.server({
      ...input,
      serverUrl: new URL(`http://127.0.0.1:${upstream.port}`),
    })
    // A gateway that failed to bind the pinned port returns {} with no dispose;
    // asserting this keeps a lost port race from silently false-passing below.
    expect(hooks.dispose).toBeInstanceOf(Function)

    const restore = () => {
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
      if (previousMobile === undefined) delete process.env.OPENCODE_MOBILE_PASSWORD
      else process.env.OPENCODE_MOBILE_PASSWORD = previousMobile
      if (previousUpstream === undefined) delete process.env.OPENCODE_MOBILE_UPSTREAM
      else process.env.OPENCODE_MOBILE_UPSTREAM = previousUpstream
      if (previousHost === undefined) delete process.env.OPENCODE_MOBILE_HOST
      else process.env.OPENCODE_MOBILE_HOST = previousHost
      if (previousPort === undefined) delete process.env.OPENCODE_MOBILE_PORT
      else process.env.OPENCODE_MOBILE_PORT = previousPort
    }
    restore()

    const auth = `Basic ${Buffer.from("opencode:phone").toString("base64")}`
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/task-4-marker`, {
      headers: { authorization: auth },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("task-4-upstream-ok")
    expect(requests).toContain("/task-4-marker")

    await hooks.dispose?.()
    stopGateway()
    upstream.stop(true)
  })
})