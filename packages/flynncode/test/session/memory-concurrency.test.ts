import { expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Stream } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionProjector } from "@flynncode/core/session/projector"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { LLMEvent } from "@flynncode/llm"
import { SessionMemoryCurate } from "@/session/memory-curate"
import { Session } from "@/session/session"
import { Memory } from "@/memory/memory"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

class Transport extends Context.Service<Transport, {
  calls: Ref.Ref<number>
  started: Deferred.Deferred<void>
  release: Deferred.Deferred<void>
}>()("@test/CurationTransport") {}
const transport = Layer.effect(Transport, Effect.gen(function* () {
  return { calls: yield* Ref.make(0), started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
}))
const llm = Layer.effect(LLM.Service, Effect.gen(function* () {
  const control = yield* Transport
  return LLM.Service.of({ stream: input => Stream.fromEffect(Effect.gen(function* () {
    yield* Ref.update(control.calls, count => count + 1)
    yield* Deferred.succeed(control.started, undefined)
    const prompt = JSON.stringify(input.messages)
    if (!prompt.includes("NEW")) yield* Deferred.await(control.release)
    return LLMEvent.textDelta({ id: "memory", text: prompt.includes("OTHER") ? "SLUG: other\n- other topic" : prompt.includes("NEW") ? "SLUG: convention\n- new convention" : "SLUG: convention\n- old convention" })
  })) })
})).pipe(Layer.provideMerge(transport))
const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([
  SessionMemoryCurate.node, Memory.node, Session.node, SessionProjector.node, CrossSpawnSpawner.node,
]), [
  [Config.node, Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ memory: { enabled: true, min_turns: 1 } }) }))],
  [Provider.node, ProviderTest.fake({ model: { id: "test-model", providerID: "test" } as Provider.Model }).layer],
  [LLM.node, llm],
]), llm))

const add = (sessionID: SessionID, text: string) => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({ id: MessageID.ascending(), role: "user", sessionID, agent: "build", model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }, time: { created: Date.now() } })
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID, messageID: message.id, type: "text", text })
  return yield* sessions.messages({ sessionID })
})

it.instance("identical snapshots coalesce concurrent and repeated inference", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const curate = yield* SessionMemoryCurate.Service
  const control = yield* Transport
  const session = yield* sessions.create({})
  const history = yield* add(session.id, "OLD")
  const work = yield* Effect.all([curate.extractFor(session.id, history), curate.extractFor(session.id, history)], { concurrency: "unbounded" }).pipe(Effect.forkChild)
  yield* Deferred.await(control.started)
  yield* Deferred.succeed(control.release, undefined)
  yield* Fiber.join(work)
  yield* curate.extractFor(session.id, history)
  expect(yield* Ref.get(control.calls)).toBe(1)
}))

it.instance("an old completion cannot overwrite a newer history or resurrect an older snapshot", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const curate = yield* SessionMemoryCurate.Service
  const memory = yield* Memory.Service
  const control = yield* Transport
  const session = yield* sessions.create({})
  const old = yield* add(session.id, "OLD")
  const work = yield* curate.extractFor(session.id, old).pipe(Effect.forkChild)
  yield* Deferred.await(control.started)
  const newer = yield* add(session.id, "NEW")
  yield* curate.extractFor(session.id, newer)
  yield* Deferred.succeed(control.release, undefined)
  yield* Fiber.join(work)
  yield* curate.extractFor(session.id, old)
  expect((yield* memory.load()).map(item => item.content).join("\n")).toContain("new convention")
  expect((yield* memory.load()).map(item => item.content).join("\n")).not.toContain("old convention")
  expect(yield* Ref.get(control.calls)).toBe(2)
}))

it.instance("shared topics reconcile against concurrent sessions and explicit edits", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const curate = yield* SessionMemoryCurate.Service
  const memory = yield* Memory.Service
  const control = yield* Transport
  const a = yield* sessions.create({})
  const b = yield* sessions.create({})
  const old = yield* add(a.id, "OLD")
  const work = yield* curate.extractFor(a.id, old).pipe(Effect.forkChild)
  yield* Deferred.await(control.started)
  yield* curate.extractFor(b.id, yield* add(b.id, "NEW"))
  yield* memory.update({ scope: "project", slug: "convention", text: "explicit edit" })
  yield* Deferred.succeed(control.release, undefined)
  yield* Fiber.join(work)
  expect((yield* memory.load()).map(item => item.content).join("\n")).toContain("explicit edit")
  expect(yield* Ref.get(control.calls)).toBe(2)
}))

it.instance("distinct sessions and topics are not deduped together", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const curate = yield* SessionMemoryCurate.Service
  const memory = yield* Memory.Service
  const control = yield* Transport
  const a = yield* sessions.create({})
  const b = yield* sessions.create({})
  yield* Deferred.succeed(control.release, undefined)
  yield* Effect.all([curate.extractFor(a.id, yield* add(a.id, "OLD")), curate.extractFor(b.id, yield* add(b.id, "OTHER"))], { concurrency: "unbounded" })
  expect(yield* Ref.get(control.calls)).toBe(2)
  expect(yield* memory.load()).toHaveLength(2)
}))

it.instance("cancellation releases in-flight snapshot ownership", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const curate = yield* SessionMemoryCurate.Service
  const control = yield* Transport
  const session = yield* sessions.create({})
  const history = yield* add(session.id, "OLD")
  const work = yield* curate.extractFor(session.id, history).pipe(Effect.forkChild)
  yield* Deferred.await(control.started)
  yield* Fiber.interrupt(work)
  yield* Deferred.succeed(control.release, undefined)
  yield* curate.extractFor(session.id, history)
  expect(yield* Ref.get(control.calls)).toBe(2)
  const memory = yield* Memory.Service
  expect(yield* memory.load()).toHaveLength(1)
}))

it.instance("instance disposal interrupts pending inference and prevents persistence", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const curate = yield* SessionMemoryCurate.Service
  const control = yield* Transport
  const memory = yield* Memory.Service
  const store = yield* InstanceStore.Service
  const instance = yield* InstanceState.context
  const session = yield* sessions.create({})
  const history = yield* add(session.id, "OLD")
  const work = yield* curate.extractFor(session.id, history).pipe(Effect.forkChild)
  yield* Deferred.await(control.started)
  yield* store.dispose(instance)
  expect(Exit.isFailure(yield* Fiber.await(work))).toBe(true)
  expect(yield* memory.load()).toEqual([])
}))
