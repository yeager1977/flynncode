import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { MessageID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Parameters, TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
    Worktree.node,
  ]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)

const it = testEffect(layer)

function stubOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: () =>
      // The child never gets to prompt: worktree isolation fails first here.
      Effect.never,
  }
}

describe("task isolation params", () => {
  test("defaults to inherit and retain", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({
      description: "scan repo",
      prompt: "find dead code",
      subagent_type: "explore",
    })
    expect(decoded.isolation ?? "inherit").toBe("inherit")
    expect(decoded.cleanup ?? "retain").toBe("retain")
  })

  test("accepts worktree isolation with dispose cleanup", () => {
    const decoded = Schema.decodeUnknownSync(Parameters)({
      description: "scan repo",
      prompt: "find dead code",
      subagent_type: "explore",
      isolation: "worktree",
      cleanup: "dispose",
    })
    expect(decoded.isolation).toBe("worktree")
    expect(decoded.cleanup).toBe("dispose")
  })

  it.instance(
    "worktree isolation on a non-git directory fails cleanly",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Non-git parent" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        const assistant: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          variant: "xhigh",
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def
          .execute(
            {
              description: "scan repo",
              prompt: "find dead code",
              subagent_type: "general",
              isolation: "worktree",
              cleanup: "retain",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isSuccess(result)) throw new Error("expected task failure")
        const failure = Cause.squash(result.cause)
        expect(failure).toBeInstanceOf(Error)
        if (!(failure instanceof Error)) throw new Error("expected Error defect")
        expect(failure.message).toContain("isolation: worktree requires a git project")
        // The failure is an actionable Plain Error, not the raw Worktree tagged error.
        expect(failure.message).not.toContain("Worktrees are only supported for git projects")
      }),
  )
})