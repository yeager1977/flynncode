import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createGateway } from "../src/gateway.ts"
import type { Manifest } from "../src/sync-decide.ts"
import { createSyncGate, type SyncGate, type SyncPeer } from "../src/sync-gate.ts"
import { pairWithPeer } from "../src/sync-pair.ts"
import { createSyncWorker, type SyncWorker } from "../src/sync-worker.ts"

// Two real opencode servers with separate data/config dirs stand in for
// challenger and starship; gateways, gates and workers run in this process
// exactly as the desktop sidecar runs them.
const OPENCODE_DIR = path.resolve(import.meta.dir, "../../opencode")
const PASSWORD = "e2e-server-secret"
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`

type Machine = {
  root: string
  url: string
  child: ReturnType<typeof Bun.spawn>
  gate: SyncGate
  gateway: ReturnType<typeof Bun.serve>
  worker: SyncWorker
  paired: SyncPeer[]
}

const state = { shared: "", project: "", missing: "" }
const machines: Machine[] = []
// Registered the moment a resource exists so a failed setup never leaks a server.
const cleanups: Array<() => Promise<void>> = []

async function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}

function spawnServer(root: string, port: number) {
  const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("OPENCODE_")))
  const child = Bun.spawn(["bun", "run", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: OPENCODE_DIR,
    env: {
      ...env,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      // Set after the OPENCODE_* scrub above: core resolves the home directory
      // from OPENCODE_TEST_HOME before os.homedir(), so neither can reach the real one.
      HOME: root,
      OPENCODE_TEST_HOME: root,
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_MODELS_PATH: path.join(OPENCODE_DIR, "test", "tool", "fixtures", "models-api.json"),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  return { child, url: `http://127.0.0.1:${port}` }
}

async function waitForServer(server: { url: string }, root: string) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const ready = await fetch(`${server.url}/flynncode-sync/manifest`, {
      headers: { authorization: AUTH },
      signal: AbortSignal.timeout(2_000),
    }).then(
      (response) => response.ok,
      () => false,
    )
    if (ready) return
    await Bun.sleep(250)
  }
  throw new Error(`opencode server in ${root} did not start`)
}

async function machine(name: string): Promise<Machine> {
  const root = await mkdtemp(path.join(tmpdir(), `flynncode-sync-${name}-`))
  // Both ports are chosen up front and the gateway binds before the server
  // spawns, so the two can never be handed the same port.
  const serverPort = await freePort()
  const gatewayPort = await freePort()
  if (gatewayPort === serverPort) throw new Error("ports collided")
  const url = `http://127.0.0.1:${serverPort}`
  const paired: SyncPeer[] = []
  // The advertised port is this gateway's real test port, never the user's 4097.
  const gate = createSyncGate({
    machineName: name,
    gatewayPort,
    phoneAccess: false,
    paused: false,
    peer: undefined,
    prefs: undefined,
    onPaired: (peer) => paired.push(peer),
  })
  const handle = createGateway({
    options: {
      host: "127.0.0.1",
      port: 0,
      upstream: url,
      username: "opencode",
      password: "phone",
      upstreamPassword: PASSWORD,
      relayToken: "",
    },
    sync: gate,
  })
  const gateway = Bun.serve({
    port: gatewayPort,
    hostname: "127.0.0.1",
    fetch: (request, srv) => handle(request, srv.requestIP(request)?.address),
  })
  cleanups.push(async () => gateway.stop(true))
  const server = spawnServer(root, serverPort)
  cleanups.push(async () => {
    server.child.kill()
    // A server stuck in graceful shutdown must not hang the suite.
    const exited = await Promise.race([server.child.exited, Bun.sleep(5_000).then(() => undefined)])
    if (exited === undefined) {
      server.child.kill("SIGKILL")
      await server.child.exited
    }
    await rm(root, { recursive: true, force: true })
  })
  await waitForServer(server, root)
  const worker = createSyncWorker({
    local: { url: server.url, authorization: AUTH },
    peer: () => gate.peer(),
    paused: () => gate.paused(),
    prefs: { get: () => gate.prefs(), apply: (prefs) => gate.update({ prefs }) },
    takeSent: () => gate.takeSent(),
    onStatus: () => undefined,
  })
  const result = { root, url: server.url, child: server.child, gate, gateway, worker, paired }
  machines.push(result)
  return result
}

function local(target: Machine, pathname: string, body?: unknown) {
  return fetch(`${target.url}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function manifest(target: Machine) {
  return (await (await local(target, "/flynncode-sync/manifest")).json()) as Manifest
}

async function title(target: Machine, id: string) {
  const response = await local(target, `/flynncode-sync/session/${id}`)
  if (!response.ok) return undefined
  return ((await response.json()) as { session: { title: string } }).session.title
}

function bundle(input: { id: string; title: string; timeUpdated: number; directory: string }) {
  return {
    version: 1,
    session: {
      id: input.id,
      project_id: "global",
      workspace_id: null,
      parent_id: null,
      slug: input.id,
      directory: input.directory,
      path: null,
      title: input.title,
      version: "e2e",
      share_url: null,
      summary_additions: null,
      summary_deletions: null,
      summary_files: null,
      summary_diffs: null,
      metadata: null,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      revert: null,
      permission: null,
      agent: null,
      kind: "code",
      model: null,
      time_created: 1,
      time_updated: input.timeUpdated,
      time_compacting: null,
      time_archived: null,
    },
    project: {
      id: "global",
      worktree: "/",
      vcs: null,
      name: null,
      icon_url: null,
      icon_url_override: null,
      icon_color: null,
      time_created: 1,
      time_updated: 1,
      time_initialized: null,
      sandboxes: [],
      commands: null,
    },
    messages: [],
    parts: [],
    todos: [],
    folders: [],
    inputs: [],
    sessionMessages: [],
    contextEpoch: null,
    eventSequence: null,
    events: [],
  }
}

// What the sync worker would send as the precondition for a local write.
async function expected(target: Machine, id: string) {
  const current = (await manifest(target)).sessions.find((session) => session.id === id)
  return current ? { timeUpdated: current.timeUpdated, timeArchived: current.timeArchived } : null
}

async function seed(target: Machine, input: { id: string; title: string; timeUpdated: number; directory?: string }) {
  const response = await local(target, "/flynncode-sync/apply", {
    bundle: bundle({ ...input, directory: input.directory ?? state.missing }),
    expected: await expected(target, input.id),
  })
  expect(response.status).toBe(200)
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const ids = (value: Manifest) => value.sessions.map((session) => session.id).sort()

beforeAll(async () => {
  state.shared = await mkdtemp(path.join(tmpdir(), "flynncode-sync-shared-"))
  // Projects live at identical paths on both machines.
  state.project = path.join(state.shared, "project")
  state.missing = path.join(state.shared, "missing-on-both")
  await mkdir(state.project, { recursive: true })
  await machine("challenger")
  await machine("starship")
  // Two servers may each take the full 90 s start deadline; leave room on top.
}, 240_000)

afterAll(async () => {
  // Every cleanup runs even if an earlier one throws, so no server is left behind.
  const failures: unknown[] = []
  for (const cleanup of cleanups.reverse()) await cleanup().catch((error: unknown) => failures.push(error))
  await rm(state.shared, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  if (failures.length > 0) throw new AggregateError(failures, "sync e2e cleanup failed")
})

describe("machine sync end to end", () => {
  test("pairs with a code and a 256-bit token", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    challenger.gate.setPairingCode({ code: "482913", expiresAt: Date.now() + 600_000 })
    const result = await pairWithPeer({ host: `127.0.0.1:${challenger.gateway.port}`, code: "482913", name: "starship" })
    if (!result.ok) throw new Error(`pairing failed: ${result.reason}`)
    starship.gate.update({ peer: result.peer })
    expect(result.peer.name).toBe("challenger")
    expect(result.peer.token).toMatch(/^[0-9a-f]{64}$/)
    expect(challenger.paired).toEqual([
      { name: "starship", url: `http://127.0.0.1:${challenger.gateway.port}`, token: result.peer.token },
    ])
    // Both gateways share 127.0.0.1 here, so point challenger at starship's real port.
    challenger.gate.update({ peer: { ...result.peer, name: "starship", url: `http://127.0.0.1:${starship.gateway.port}` } })
  })

  test("syncs chats both ways, and settings without secrets and prefs from challenger", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    await seed(challenger, { id: "ses_e2e_a1", title: "a1", timeUpdated: 1000 })
    await seed(challenger, { id: "ses_e2e_a2", title: "a2", timeUpdated: 1000 })
    await seed(starship, { id: "ses_e2e_b1", title: "b1", timeUpdated: 1000 })
    const config = path.join(challenger.root, "config", "opencode", "opencode.jsonc")
    await Bun.write(config, `{\n  "model": "anthropic/claude-e2e",\n  "provider": { "anthropic": { "options": { "apiKey": "sk-challenger-secret" } } }\n}\n`)
    await utimes(config, new Date(), new Date())
    challenger.gate.update({ prefs: { sections: { appearance: { fontSize: 18 } }, updatedAt: 50 } })

    const pulled = await starship.worker.cycle()
    await challenger.worker.cycle()

    expect(pulled).toMatchObject({ phase: "idle", received: 2 })
    expect(ids(await manifest(starship))).toEqual(["ses_e2e_a1", "ses_e2e_a2", "ses_e2e_b1"])
    expect(ids(await manifest(challenger))).toEqual(["ses_e2e_a1", "ses_e2e_a2", "ses_e2e_b1"])
    const copied = await Bun.file(path.join(starship.root, "config", "opencode", "opencode.jsonc")).text()
    expect(copied).toContain("anthropic/claude-e2e")
    expect(copied).not.toContain("sk-challenger-secret")
    expect(starship.gate.prefs()).toEqual({ sections: { appearance: { fontSize: 18 } }, updatedAt: 50 })
  }, 60_000)

  test("the newest copy wins a conflict", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    await seed(challenger, { id: "ses_e2e_a1", title: "edited on challenger", timeUpdated: 2000 })
    await seed(starship, { id: "ses_e2e_a1", title: "edited on starship", timeUpdated: 3000 })
    await challenger.worker.cycle()
    await starship.worker.cycle()
    expect(await title(challenger, "ses_e2e_a1")).toBe("edited on starship")
    expect(await title(starship, "ses_e2e_a1")).toBe("edited on starship")
  }, 60_000)

  test("the side holding the newer copy keeps it when it cycles first", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    await seed(challenger, { id: "ses_e2e_a1", title: "older on challenger", timeUpdated: 4000 })
    await seed(starship, { id: "ses_e2e_a1", title: "newer on starship", timeUpdated: 5000 })
    await starship.worker.cycle()
    // A pull-on-any-difference rule would have replaced starship's newer copy here.
    expect(await title(starship, "ses_e2e_a1")).toBe("newer on starship")
    expect(await title(challenger, "ses_e2e_a1")).toBe("older on challenger")
    await challenger.worker.cycle()
    expect(await title(challenger, "ses_e2e_a1")).toBe("newer on starship")
    expect(await title(starship, "ses_e2e_a1")).toBe("newer on starship")
  }, 60_000)

  test("newer settings and prefs flow back while each machine keeps its own secrets", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    const starshipConfig = path.join(starship.root, "config", "opencode", "opencode.jsonc")
    await Bun.write(
      starshipConfig,
      `{\n  "model": "anthropic/claude-e2e-newer",\n  "provider": { "anthropic": { "options": { "apiKey": "sk-starship-secret" } } }\n}\n`,
    )
    const later = new Date(Date.now() + 60_000)
    await utimes(starshipConfig, later, later)
    starship.gate.update({ prefs: { sections: { appearance: { fontSize: 20 } }, updatedAt: 90 } })

    await challenger.worker.cycle()

    const challengerConfig = await Bun.file(path.join(challenger.root, "config", "opencode", "opencode.jsonc")).text()
    expect(challengerConfig).toContain("anthropic/claude-e2e-newer")
    expect(challengerConfig).toContain("sk-challenger-secret")
    expect(challengerConfig).not.toContain("sk-starship-secret")
    expect(await Bun.file(starshipConfig).text()).toContain("sk-starship-secret")
    expect(challenger.gate.prefs()).toEqual({ sections: { appearance: { fontSize: 20 } }, updatedAt: 90 })
  }, 60_000)

  test("a delete propagates and is not pulled back", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    expect(
      (
        await local(challenger, "/flynncode-sync/delete/ses_e2e_a2", {
          timeDeleted: Date.now(),
          expected: await expected(challenger, "ses_e2e_a2"),
        })
      ).status,
    ).toBe(200)
    await starship.worker.cycle()
    await challenger.worker.cycle()
    expect(ids(await manifest(starship))).not.toContain("ses_e2e_a2")
    expect(ids(await manifest(challenger))).not.toContain("ses_e2e_a2")
    expect((await manifest(starship)).tombstones.map((tombstone) => tombstone.id)).toContain("ses_e2e_a2")
  }, 60_000)

  test("an archive propagates", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    expect(
      (
        await local(starship, "/flynncode-sync/archive/ses_e2e_b1", {
          timeArchived: Date.now(),
          expected: await expected(starship, "ses_e2e_b1"),
        })
      ).status,
    ).toBe(200)
    await challenger.worker.cycle()
    const archived = (await manifest(challenger)).sessions.find((session) => session.id === "ses_e2e_b1")
    expect(archived?.timeArchived).toBeNumber()
  }, 60_000)

  test("a running chat is skipped until it finishes", async () => {
    const [challenger, starship] = machines
    if (!challenger || !starship) throw new Error("machines missing")
    await seed(challenger, { id: "ses_e2e_run", title: "run", timeUpdated: 1000, directory: state.project })
    await starship.worker.cycle()
    expect(await title(starship, "ses_e2e_run")).toBe("run")

    // A shell command marks the chat busy on starship for several seconds (polling below does not depend on the exact length).
    const running = fetch(`${starship.url}/session/ses_e2e_run/shell`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json", "x-opencode-directory": state.project },
      body: JSON.stringify({ agent: "build", model: { providerID: "test", modelID: "test" }, command: "sleep 8" }),
    }).then(
      (response) => response.status,
      () => 0,
    )
    const busy = async () =>
      (await manifest(starship)).sessions.some((session) => session.id === "ses_e2e_run" && session.busy)
    await waitFor(busy, "the chat to run on starship")
    // Asked directly mid-turn, starship's gateway refuses to hand out a half-written copy.
    const midTurn = await fetch(`http://127.0.0.1:${starship.gateway.port}/flynncode-sync/session/ses_e2e_run`, {
      headers: { authorization: `Bearer ${starship.gate.peer()?.token}` },
    })
    expect(midTurn.status).toBe(409)

    await seed(challenger, { id: "ses_e2e_run", title: "newer on challenger", timeUpdated: Date.now() + 60_000, directory: state.project })
    const skipped = await starship.worker.cycle()
    expect(skipped.skipped).toContainEqual({ id: "ses_e2e_run", reason: "local-busy" })
    expect(await title(starship, "ses_e2e_run")).not.toBe("newer on challenger")

    expect(await running).toBe(200)
    await waitFor(async () => !(await busy()), "the chat to finish on starship")
    await starship.worker.cycle()
    expect(await title(starship, "ses_e2e_run")).toBe("newer on challenger")
  }, 90_000)
})
