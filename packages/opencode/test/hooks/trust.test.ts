import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import os from "os"
import path from "path"
import { testEffect } from "../lib/effect"
import { HooksTrust } from "../../src/hooks/trust"
import { HooksConfig } from "../../src/hooks/config"
import { HooksExecutor } from "../../src/hooks/executor"
import { HooksManaged } from "../../src/hooks/managed"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { tmpdir } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(HooksTrust.node))

const trustPath = path.join(os.tmpdir(), `opencode-hooks-trust-${process.pid}.json`)

// Managed-hook fixture for the kill-switch test: mirrors managed.test.ts so
// the executor layer sees a hook the managed policy pre-trusts.
const killManagedDir = path.join(os.tmpdir(), `opencode-hooks-kill-${process.pid}`)
const killManagedScript = path.join(killManagedDir, "managed.sh")
const killMarker = path.join(killManagedDir, "marker.txt")

beforeEach(async () => {
  process.env["FLYNNCODE_HOOKS_TRUST_FILE"] = trustPath
  const file = Bun.file(trustPath)
  if (await file.exists()) await Bun.write(trustPath, "[]")
  process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = killManagedDir
  await Bun.write(
    path.join(killManagedDir, "opencode.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: killManagedScript }] }] },
    }),
  )
  await Bun.write(killMarker, "pristine")
  await Bun.write(killManagedScript, `#!/bin/sh\necho ran > "${killMarker}"\n`)
  const { chmod } = await import("node:fs/promises")
  await chmod(killManagedScript, 0o755)
})

afterEach(async () => {
  delete process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"]
  try {
    await Bun.write(trustPath, "[]")
  } catch {
    return
  }
})

describe("hooks trust", () => {
  it.effect("untrusted by default, trusted after trust, revoked after revoke", () =>
    Effect.gen(function* () {
      const svc = yield* HooksTrust.Service
      const def = { event: "PreToolUse", matcher: "^Bash$", type: "command", command: "python3 hooks/check.py" } as const
      expect(yield* svc.isTrusted(def)).toBe(false)
      yield* svc.trust(def)
      expect(yield* svc.isTrusted(def)).toBe(true)
      yield* svc.revoke(svc.hashDef(def))
      expect(yield* svc.isTrusted(def)).toBe(false)
    }),
  )

  it.effect("changed definition requires re-review", () =>
    Effect.gen(function* () {
      const svc = yield* HooksTrust.Service
      const before = { event: "PreToolUse", matcher: "^Bash$", type: "command", command: "python3 hooks/check.py" } as const
      const after = { event: "PreToolUse", matcher: "^Bash$", type: "command", command: "python3 hooks/check.py --strict" } as const
      yield* svc.trust(before)
      expect(yield* svc.isTrusted(before)).toBe(true)
      // Fail closed: edited command has a different hash and is untrusted.
      expect(yield* svc.isTrusted(after)).toBe(false)
      yield* svc.revoke(svc.hashDef(before))
    }),
  )
})

test("timeout edits re-trigger review", () => {
  const base = { event: "PreToolUse", matcher: "", type: "command", command: "check.sh" } as const
  expect(HooksTrust.hashDef({ ...base, timeout: 1000 })).not.toBe(HooksTrust.hashDef({ ...base, timeout: 2000 }))
  expect(HooksTrust.hashDef({ ...base })).not.toBe(HooksTrust.hashDef({ ...base, timeout: 1000 }))
})

test("type change changes the hash", () => {
  expect(
    HooksTrust.hashDef({ event: "PreToolUse", matcher: "", type: "command", command: "check.sh" }),
  ).not.toBe(
    HooksTrust.hashDef({ event: "PreToolUse", matcher: "", type: "mcp_tool", server: "s", tool: "t" }),
  )
})

test("mcp_tool input edits re-trigger review", () => {
  const base = { event: "PreToolUse", matcher: "", type: "mcp_tool", server: "s", tool: "t" } as const
  expect(HooksTrust.hashDef({ ...base, input: { a: 1 } })).not.toBe(HooksTrust.hashDef({ ...base, input: { a: 2 } }))
})

test("canonical form is key-order stable", () => {
  const left = { event: "PreToolUse", matcher: "", type: "command", command: "a", timeout: 5 } as const
  const right = { timeout: 5, command: "a", type: "command", matcher: "", event: "PreToolUse" } as const
  expect(HooksTrust.hashDef(left)).toBe(HooksTrust.hashDef(right))
})

test("fromHandler captures the full normative model", () => {
  const def = HooksTrust.fromHandler("PreToolUse", "^Bash$", {
    type: "command",
    command: "check.sh",
    timeout: 5000,
    async: true,
  })
  expect(def).toMatchObject({ event: "PreToolUse", matcher: "^Bash$", type: "command", timeout: 5000, async: true })
  const mcp = HooksTrust.fromHandler("PostToolUse", undefined, { type: "mcp_tool", server: "s", tool: "t" })
  expect(mcp).toMatchObject({ event: "PostToolUse", matcher: "", type: "mcp_tool", server: "s", tool: "t" })
})

describe("hooks trust project binding", () => {
  const def = { event: "PreToolUse", matcher: "", type: "command", command: "python3 hooks/check.py --strict" } as const

  test("the same hook in another project is a different identity", async () => {
    await using tmp = await tmpdir()
    const a = await Effect.runPromise(HooksTrust.bind(def, { id: "project-a", root: tmp.path, cwd: tmp.path }))
    const b = await Effect.runPromise(HooksTrust.bind(def, { id: "project-b", root: tmp.path, cwd: tmp.path }))
    expect(HooksTrust.hashDef(a)).not.toBe(HooksTrust.hashDef(b))
  })

  test("editing a referenced project script re-triggers review", async () => {
    await using tmp = await tmpdir()
    const project = { id: "project-a", root: tmp.path, cwd: tmp.path }
    await Bun.write(path.join(tmp.path, "hooks", "check.py"), "print('ok')")
    const before = await Effect.runPromise(HooksTrust.bind(def, project))
    expect(before.files).toEqual({ [path.join("hooks", "check.py")]: expect.any(String) })

    await Bun.write(path.join(tmp.path, "hooks", "check.py"), "import os; os.system('curl evil')")
    const after = await Effect.runPromise(HooksTrust.bind(def, project))
    expect(HooksTrust.hashDef(after)).not.toBe(HooksTrust.hashDef(before))
  })

  test("files outside the project are not hashed", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    await Bun.write(path.join(outside.path, "check.sh"), "echo")
    const bound = await Effect.runPromise(
      HooksTrust.bind(
        { event: "PreToolUse", matcher: "", type: "command", command: `sh ${path.join(outside.path, "check.sh")}` },
        { id: "project-a", root: root.path, cwd: root.path },
      ),
    )
    expect(bound.files).toBeUndefined()
    expect(bound.scope).toBe("project-a")
  })
})

test("project and global hooks merge without replacing", () => {
  const merged = HooksConfig.mergeHooksConfigs(
    { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "global.py" }] }] },
    { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "project.py" }] }] },
  )
  expect(merged.PreToolUse?.length).toBe(2)
})

function configLayer(hooks: Record<string, unknown>) {
  return Layer.succeed(
    Config.Service,
    { get: () => Effect.succeed({ hooks }) } as Partial<Config.Interface> as Config.Interface,
  )
}

describe("hooks kill switch", () => {
  // The kill switch is orthogonal to the trust bypass flag: it wins in both
  // directions, so the bypass flag is deliberately ON here to pin that
  // disableAllHooks still suppresses everything.
  const killIt = testEffect(
    LayerNode.compile(LayerNode.group([HooksExecutor.node, HooksManaged.node]), [
      [
        Config.node,
        configLayer({
          disableAllHooks: true,
          PreToolUse: [{ hooks: [{ type: "command", command: killManagedScript }] }],
        }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ bypassHookTrust: true })],
    ]),
  )

  killIt.live("disableAllHooks suppresses even managed hooks", () =>
    Effect.gen(function* () {
      const executor = yield* HooksExecutor.Service
      const decision = yield* executor.runDecision({
        event: "PreToolUse",
        matchName: "Bash",
        tool: "Bash",
        sessionID: "ses_1",
        callID: "c1",
        args: { command: "ls" },
      })
      // The event is skipped entirely: no spawn, no deny, default undecided.
      expect(decision).toEqual({ behavior: "undecided" })
      expect(yield* Effect.promise(() => Bun.file(killMarker).text())).toBe("pristine")
    }),
  )

  // Positive control for the suppression test above: the same fixture with
  // the flag off proves the managed pre-trust is live and the hook spawns.
  const runIt = testEffect(
    LayerNode.compile(LayerNode.group([HooksExecutor.node, HooksManaged.node]), [
      [
        Config.node,
        configLayer({ PreToolUse: [{ hooks: [{ type: "command", command: killManagedScript }] }] }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({})],
    ]),
  )

  runIt.live("kill switch off lets the managed hook run", () =>
    Effect.gen(function* () {
      const executor = yield* HooksExecutor.Service
      const decision = yield* executor.runDecision({
        event: "PreToolUse",
        matchName: "Bash",
        tool: "Bash",
        sessionID: "ses_1",
        callID: "c1",
        args: { command: "ls" },
      })
      // The hook spawned (proving the fixture is live): its echo redirects
      // into the marker, so empty stdout stays an undecided no-op.
      expect(decision).toEqual({ behavior: "undecided" })
      expect(yield* Effect.promise(() => Bun.file(killMarker).text())).toBe("ran\n")
    }),
  )
})
