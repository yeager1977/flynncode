import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { AutoReviewer } from "@/permission/auto-reviewer"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(HttpApiApp.app, [
  [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
  [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  [LLM.node, Layer.mock(LLM.Service, { stream: () => Stream.fromEffect(Effect.gen(function* () {
    const instance = yield* InstanceState.context
    if (!instance.directory.includes("opencode-test-")) throw new Error("review lost instance scope")
    return LLMEvent.textDelta({ id: "verdict", text: "VERDICT: deny" })
  })) })],
]))

it.instance("desktop HTTP graph can invoke the auto reviewer with location context", () => Effect.gen(function* () {
  const reviewer = yield* Effect.serviceOption(AutoReviewer.Service)
  expect(Option.isSome(reviewer)).toBe(true)
  if (Option.isNone(reviewer)) throw new Error("HTTP graph omitted AutoReviewer")
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ model: { providerID: "test" as never, id: "test-model" as never } })
  expect(yield* reviewer.value.request({ sessionID: session.id, tool: "bash", args: { command: "git status" }, permission: "bash", patterns: ["git status"] })).toBe("deny")
}), { config: { provider: { test: { npm: "@ai-sdk/openai-compatible", models: { "test-model": { name: "Test", limit: { context: 100000, output: 10000 } } } } } } })
