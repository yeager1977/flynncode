import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { createHash } from "crypto"
import os from "os"
import path from "path"
import { ConfigHooksV1 } from "@flynncode/core/v1/config/hooks"
import { InstanceState } from "@/effect/instance-state"

// Full normative hook model: every field that changes hook behavior is part
// of the trusted identity, so any edit re-triggers review (fail closed).
export type HookDef = {
  event: string
  matcher: string
  type: "command" | "mcp_tool"
  command?: string
  timeout?: number
  server?: string
  tool?: string
  input?: Record<string, unknown>
  async?: boolean
  additionalContextLimit?: number
  statusMessage?: string
  // Set by bind(): the project the hook was trusted in, and content hashes
  // of project files the command references.
  scope?: string
  files?: Record<string, string>
}

// Trust is per project: the same hook definition in another repository is a
// different hook, and editing a project script the command runs re-triggers
// review. Every command token that resolves (against the hook's cwd) to a
// readable file inside the project root contributes its content hash.
export const bind = Effect.fn("HooksTrust.bind")(function* (
  def: HookDef,
  project: { id: string; root: string; cwd: string },
) {
  if (def.type !== "command" || !def.command) return { ...def, scope: project.id }
  const candidates = [
    ...new Set(
      def.command
        .split(/[\s;|&()<>`]+/)
        .map((token) => token.replace(/^['"]|['"]$/g, ""))
        .filter((token) => token !== "" && !token.startsWith("-"))
        .map((token) => path.resolve(project.cwd, token))
        .filter((file) => inside(project.root, file)),
    ),
  ]
  const hashed = yield* Effect.forEach(
    candidates,
    (file) =>
      Effect.tryPromise(() => Bun.file(file).bytes()).pipe(
        Effect.map(
          (bytes) => [path.relative(project.root, file), createHash("sha256").update(bytes).digest("hex")] as const,
        ),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    { concurrency: 8 },
  )
  const files = Object.fromEntries(hashed.filter((entry) => entry !== undefined))
  return { ...def, scope: project.id, ...(Object.keys(files).length > 0 ? { files } : {}) }
})

// Bind to the current instance's project. Outside an instance (isolated
// tests, tooling) the definition is used as-is.
export const bindToInstance = Effect.fn("HooksTrust.bindToInstance")(function* (def: HookDef) {
  const ctx = yield* InstanceState.context.pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  if (!ctx) return def
  return yield* bind(def, { id: ctx.project.id, root: ctx.worktree, cwd: ctx.directory })
})

function inside(root: string, file: string) {
  const rel = path.relative(root, file)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry) => entry[1] !== undefined)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map((entry) => [entry[0], stable(entry[1])]),
    )
  }
  return value
}

export function canonicalize(def: HookDef) {
  return JSON.stringify(stable(def))
}

export function hashDef(def: HookDef) {
  return createHash("sha256").update(canonicalize(def)).digest("hex")
}

export function fromHandler(
  event: string,
  matcher: string | undefined,
  handler: ConfigHooksV1.HookHandler,
): HookDef {
  if (handler.type === "command") {
    return {
      event,
      matcher: matcher ?? "",
      type: "command",
      command: handler.command,
      timeout: handler.timeout,
      async: handler.async,
      additionalContextLimit: handler.additionalContextLimit,
      statusMessage: handler.statusMessage,
    }
  }
  return {
    event,
    matcher: matcher ?? "",
    type: "mcp_tool",
    server: handler.server,
    tool: handler.tool,
    input: handler.input,
    timeout: handler.timeout,
    statusMessage: handler.statusMessage,
  }
}

export interface TrustInterface {
  readonly hashDef: (def: HookDef) => string
  readonly isTrusted: (def: HookDef) => Effect.Effect<boolean>
  readonly trust: (def: HookDef) => Effect.Effect<void>
  readonly revoke: (hash: string) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Array<{ hash: string; trustedAt: number }>>
}

export class Service extends Context.Service<Service, TrustInterface>()("@opencode/HooksTrust") {}

export function trustFile() {
  const override = process.env["FLYNNCODE_HOOKS_TRUST_FILE"]
  if (override) return override
  return path.join(os.homedir(), ".local", "share", "flynncode", "hooks-trust.json")
}

const TrustFileSchema = Schema.Array(Schema.Struct({ hash: Schema.String, trustedAt: Schema.Number }))

function readHashes(): Promise<Set<string>> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const file = Bun.file(trustFile())
      const exists = yield* Effect.promise(() => file.exists())
      if (!exists) return new Set<string>()
      const raw = yield* Effect.promise(() => file.json()).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (raw === undefined) return new Set<string>()
      const decoded = Option.getOrElse(Schema.decodeUnknownOption(TrustFileSchema)(raw), () => [])
      return new Set(decoded.map((entry) => entry.hash))
    }).pipe(
      // Fail closed: any unexpected defect means untrusted.
      Effect.catch(() => Effect.succeed(new Set<string>())),
    ),
  )
}

function writeHashes(hashes: Set<string>): Promise<void> {
  const payload = Array.from(hashes).map((hash) => ({ hash, trustedAt: Date.now() }))
  return Bun.write(trustFile(), JSON.stringify(payload, null, 2)).then(() => undefined)
}

function readEntries(): Promise<Array<{ hash: string; trustedAt: number }>> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const file = Bun.file(trustFile())
      const exists = yield* Effect.promise(() => file.exists())
      if (!exists) return []
      const raw = yield* Effect.promise(() => file.json()).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (raw === undefined) return []
      const decoded = Option.getOrElse(Schema.decodeUnknownOption(TrustFileSchema)(raw), () => [])
      return decoded.map((entry) => ({ hash: entry.hash, trustedAt: entry.trustedAt }))
    }).pipe(Effect.catch(() => Effect.succeed([] as Array<{ hash: string; trustedAt: number }>))),
  )
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        hashDef,
        isTrusted: (def) => Effect.promise(() => readHashes().then((hashes) => hashes.has(hashDef(def)))),
        trust: (def) =>
          Effect.promise(async () => {
            const hashes = await readHashes()
            hashes.add(hashDef(def))
            await writeHashes(hashes)
          }),
        revoke: (hash) =>
          Effect.promise(async () => {
            const hashes = await readHashes()
            hashes.delete(hash)
            await writeHashes(hashes)
          }),
        list: () => Effect.promise(() => readEntries()),
      })
    }),
  ),
  deps: [],
})

export * as HooksTrust from "./trust"
