import * as http from "node:http"
import * as tls from "node:tls"
import { hostname } from "node:os"
import { createSyncWorker, initialStatus, type SyncStatus, type SyncWorker } from "@flynncode/mobile-gateway/sync"
import { createSyncGate, type SyncGate } from "@flynncode/mobile-gateway/sync-gate"
import {
  mobileGatewayUpstream,
  startMobileGateway,
  type MobileGatewayHandle,
} from "./mobile-gateway-launch"
import { startRelayPublisher, relayPublisherConfig } from "./relay-publisher"
import {
  createReconciler,
  gatewayWanted,
  parseSyncCommand,
  parseSyncStart,
  shutdown,
  type SidecarSyncCommand,
  type SidecarSyncMessage,
  type SidecarSyncStart,
} from "./sidecar-sync"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  mobile: { password: string; port: number }
  // Relay secrets travel in the start message rather than the sidecar env so
  // they never leak into agent shells, which inherit process.env.
  relay: RelaySettings
  // The sync peer record (with its pairing token) follows the same rule.
  sync: SidecarSyncStart
}

type RelaySettings = { token: string; remoteToken: string; url: string }

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }
  | SidecarSyncMessage

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined
let mobileGateway: MobileGatewayHandle | undefined
let relayPublisher: { stop(): void } | undefined
let syncGate: SyncGate | undefined
let syncWorker: SyncWorker | undefined
let gatewayConfig: { command: StartCommand; upstream: string } | undefined
let pairingTimer: ReturnType<typeof setTimeout> | undefined
let unpairTimer: ReturnType<typeof setTimeout> | undefined
let gatewayError: string | null = null
let lastSyncStatus: SyncStatus | undefined

// Serialised so overlapping toggles never start two gateways on port 4097.
// Failures are logged, never rejected, so quit cannot be derailed by a bad reconcile.
const reconcileGateway = createReconciler(applyGatewayState, (error) =>
  console.warn(`[sidecar] gateway reconcile failed: ${error instanceof Error ? error.message : String(error)}`),
)

parentPort.on("message", (event) => {
  const sync = parseSyncCommand(event.data)
  if (sync) {
    handleSyncCommand(sync).catch(logSyncError)
    return
  }
  const command = parseCommand(event.data)
  if (!command) {
    // A malformed start would otherwise leave main waiting out its stall timeout.
    if ((event.data as { type?: unknown } | null)?.type === "start") {
      parentPort.postMessage({ type: "error", error: { message: "Invalid sidecar start message" } })
    }
    return
  }
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Server } = await import("virtual:opencode-server")

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    const upstream = mobileGatewayUpstream(command.hostname, command.port)
    const gate = createSyncGate({
      machineName: command.sync.machineName,
      gatewayPort: command.mobile.port,
      phoneAccess: command.sync.phoneAccess,
      paused: command.sync.paused,
      peer: command.sync.peer ?? undefined,
      prefs: command.sync.prefs ?? undefined,
      onPeerMoved: (peer) => post({ type: "sync-peer-moved", peer }),
      onPaired: (peer) => {
        post({ type: "sync-paired", peer })
        void reconcileGateway()
        syncWorker?.syncNow().catch(logSyncError)
      },
      // Give the unpair request time to answer before its gateway goes down.
      onUnpaired: () => {
        post({ type: "sync-unpaired" })
        clearTimeout(unpairTimer)
        unpairTimer = setTimeout(() => void reconcileGateway(), 500)
      },
    })
    syncGate = gate
    gatewayConfig = { command, upstream }
    await reconcileGateway()
    syncWorker = createSyncWorker({
      local: { url: upstream, authorization: `Basic ${Buffer.from(`opencode:${command.password}`).toString("base64")}` },
      peer: () => gate.peer(),
      paused: () => gate.paused(),
      prefs: {
        get: () => gate.prefs(),
        apply: (prefs) => {
          gate.update({ prefs })
          post({ type: "sync-peer-prefs", prefs })
        },
      },
      takeSent: () => gate.takeSent(),
      onStatus: (status) => {
        lastSyncStatus = status
        post({ type: "sync-status", status })
      },
    })
    syncWorker.start()
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    // Each step runs even if an earlier one fails: disposing instances shuts down MCP
    // servers (with their process trees), LSPs and shells, and closing the listener
    // alone would leave them orphaned when this process exits.
    await shutdown(
      [
        { name: "sync worker", run: stopSyncWorker },
        { name: "gateway reconcile", run: settleGateway },
        { name: "relay publisher", run: stopRelayPublisher },
        { name: "gateway", run: stopGateway },
        {
          name: "instances",
          run: async () => {
            const { InstanceRuntime } = await import("virtual:opencode-server")
            await InstanceRuntime.disposeAllInstances()
          },
        },
        { name: "listener", run: () => listener?.stop() },
      ],
      (name, error) =>
        console.warn(`[sidecar] stopping the ${name} failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function stopSyncWorker() {
  syncWorker?.stop()
  syncWorker = undefined
  clearTimeout(pairingTimer)
  clearTimeout(unpairTimer)
}

function stopRelayPublisher() {
  const publisher = relayPublisher
  relayPublisher = undefined
  publisher?.stop()
}

// Drops the config first so a queued reconcile cannot restart the gateway or
// the relay publisher, then waits for any reconcile already running.
async function settleGateway() {
  gatewayConfig = undefined
  await reconcileGateway()
}

function stopGateway() {
  const gateway = mobileGateway
  mobileGateway = undefined
  gateway?.stop()
}

function logSyncError(error: unknown) {
  console.warn(`[sidecar] sync command failed: ${error instanceof Error ? error.message : String(error)}`)
}

async function handleSyncCommand(command: SidecarSyncCommand) {
  // Main waits on a sync-now requestID, so it always gets an answer.
  if (command.type === "sync-now") return replySyncNow(command.requestID)
  if (command.type === "sync-reload") return replyReload(command.requestID)
  const gate = syncGate
  if (!gate) return
  if (command.type === "sync-config") {
    const peerChanged = command.peer?.token !== gate.peer()?.token
    gate.update({ phoneAccess: command.phoneAccess, paused: command.paused, peer: command.peer })
    await reconcileGateway()
    if (peerChanged && command.peer) syncWorker?.syncNow().catch(logSyncError)
    return
  }
  if (command.type === "sync-pairing-code") {
    gate.setPairingCode({ code: command.code, expiresAt: command.expiresAt })
    clearTimeout(pairingTimer)
    // A gateway started only for pairing shuts down again once the code expires.
    pairingTimer = setTimeout(() => void reconcileGateway(), Math.max(0, command.expiresAt - Date.now()) + 1000)
    await reconcileGateway()
    return
  }
  if (command.type === "sync-prefs") {
    gate.update({ prefs: command.prefs })
    return
  }
}

async function replySyncNow(requestID: string) {
  const status = await syncWorker?.syncNow().catch((error): SyncStatus => {
    logSyncError(error)
    return { ...(lastSyncStatus ?? initialStatus()), lastError: error instanceof Error ? error.message : String(error) }
  })
  post({ type: "sync-status", status: status ?? lastSyncStatus ?? initialStatus(), requestID })
}

async function replyReload(requestID: string) {
  const status = await syncWorker?.reloadConfig().catch((error): SyncStatus => {
    logSyncError(error)
    return { ...(lastSyncStatus ?? initialStatus()), lastError: error instanceof Error ? error.message : String(error) }
  })
  post({ type: "sync-status", status: status ?? lastSyncStatus ?? initialStatus(), requestID })
}

// The gateway runs while phone access is on, a peer is paired, or a pairing
// code is waiting; the relay publisher only runs with phone access, since it
// reads the phone inbox.
async function applyGatewayState() {
  const gate = syncGate
  const config = gatewayConfig
  if (!gate || !config) return
  const wanted = gatewayWanted({ phoneAccess: gate.phoneAccess(), peer: gate.peer(), pairingActive: gate.pairingActive() })
  const failure = { message: undefined as string | undefined }
  if (wanted && !mobileGateway) {
    mobileGateway = await startMobileGateway({
      serverPassword: config.command.password,
      phonePassword: config.command.mobile.password,
      port: config.command.mobile.port,
      upstream: config.upstream,
      relayToken: config.command.relay.token,
      host: process.env.OPENCODE_MOBILE_HOST,
      sync: gate,
      onError: (message) => (failure.message = message),
    })
  }
  reportGatewayError(
    wanted && !mobileGateway
      ? `The LAN gateway could not start${failure.message ? `: ${failure.message}` : "; its port may be in use"}`
      : null,
  )
  if (!wanted && mobileGateway) {
    mobileGateway.stop()
    mobileGateway = undefined
  }
  const relayWanted = gate.phoneAccess() && mobileGateway !== undefined
  if (relayWanted && !relayPublisher) {
    relayPublisher = startRelayPublisherFor({
      relay: config.command.relay,
      gatewayPort: mobileGateway?.port,
      phonePassword: config.command.mobile.password,
    })
  }
  if (!relayWanted && relayPublisher) {
    relayPublisher.stop()
    relayPublisher = undefined
  }
}

function reportGatewayError(error: string | null) {
  if (error === gatewayError) return
  gatewayError = error
  if (error) console.warn(`[sidecar] ${error}`)
  post({ type: "sync-gateway", error })
}

function post(message: SidecarSyncMessage) {
  parentPort.postMessage(message)
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  const mobile = (command as { mobile?: unknown }).mobile
  if (!mobile || typeof mobile !== "object") return
  const mobilePassword = (mobile as { password?: unknown }).password
  const mobilePort = (mobile as { port?: unknown }).port
  if (typeof mobilePassword !== "string" || mobilePassword === "") return
  if (typeof mobilePort !== "number" || !Number.isInteger(mobilePort) || mobilePort < 0 || mobilePort > 65535) {
    return
  }
  const relay = parseRelaySettings((command as { relay?: unknown }).relay)
  if (!relay) return
  const sync = parseSyncStart((command as { sync?: unknown }).sync)
  if (!sync) return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    mobile: { password: mobilePassword, port: mobilePort },
    relay,
    sync,
  }
}

function parseRelaySettings(value: unknown): RelaySettings | undefined {
  if (!value || typeof value !== "object") return
  const relay = value as Partial<Record<keyof RelaySettings, unknown>>
  if (typeof relay.token !== "string") return
  if (typeof relay.remoteToken !== "string") return
  if (typeof relay.url !== "string") return
  return { token: relay.token, remoteToken: relay.remoteToken, url: relay.url }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

// The relay publisher pushes needs-input digests to the deepthought host so
// the phone sees them while away. It stays off unless the outbound remote
// token and the deepthought gateway URL are both configured; originID reuses
// the machine hostname rather than inventing a new identity.
function startRelayPublisherFor(input: {
  relay: RelaySettings
  gatewayPort: number | undefined
  phonePassword: string
}) {
  const config = relayPublisherConfig(
    { remoteToken: input.relay.remoteToken, url: input.relay.url },
    { gatewayPort: input.gatewayPort, phonePassword: input.phonePassword, originID: hostname() },
  )
  if (!config) return
  return startRelayPublisher(config)
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
