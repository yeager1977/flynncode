# Model Router Live Model-List Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The model router's candidate pool always mirrors the models the app considers available/enabled: vendor connect/disconnect and settings-side hides apply within one routing call, and pulls/discovery changes within ≤5 minutes — no restart, no waiting for the hourly models.dev poll.

**Architecture:** The server's per-directory Provider state becomes event-invalidated (`Integration.Event.ConnectionUpdated`) and TTL-revalidated (5 min) via a new optional `timeToLive` on `InstanceState.make`. The router plugin turns its one-shot catalog snapshot into a dirty-flag + 5-min TTL cache, and the plugin loader stops dropping location-less (global) events so the plugin actually receives invalidation signals (its existing `models-dev.refreshed` handling is currently dead). Manage Models visibility writes explicit hides into `model_router.excludeModels` (debounced config write-through), and the router editor passes the server list through instead of snapshotting.

**Tech Stack:** Effect (server), Effect `ScopedCache`, plugin hooks in `@flynncode/plugin`, SolidJS app, Bun tests, Playwright.

Spec: `docs/superpowers/specs/2026-10-14-model-router-live-model-list-design.md`

## Global Constraints

- Follow `AGENTS.md` (repo root + package dirs) style: no `else`, no unnecessary destructuring, no aliased/star imports, prefer `const`, avoid `try`/`catch` where possible, avoid `any`; Effect: bind services to named variables, no nested yields; prefer `Effect.fn` for named effects.
- In `packages/flynncode/src/*` self-export modules keep the `export * as X from "./x"` convention; the plugin files keep their current per-file exports.
- Tests run from package dirs only (never repo root): `packages/flynncode`: `bun test <file>`; `packages/app`: `bun test --conditions=solid --preload ./happydom.ts <file>` (unit dir `./src`), browser contract tests `bun test --conditions=browser --preload ./happydom.ts ./test-browser`). Typecheck with `bun typecheck` in each touched package.
- Playwright e2e per `packages/app/e2e/AGENTS.md`: no wall-clock sleeps; assert observable state.
- i18n: never hardcode user-visible English; add the key to `packages/app/src/i18n/en.ts` AND to the `keys` list in `packages/app/src/i18n/flynncode-fallback.ts`.
- Config patches REPLACE the `model_router` subtree whole (`mergeWholeSubtrees`, `packages/flynncode/src/config/config.ts:169-195`): every write of a `{ model_router: … }` patch must carry the router object fields to keep.
- Never commit unrelated working-tree changes (there are pre-existing modifications: `bun.lock`, `packages/flynncode/package.json`, `packages/flynncode/src/plugin/anthropic/subscription.ts`, `packages/flynncode/test/plugin/anthropic-subscription.test.ts`, `packages/mobile-gateway/src/bin.ts`, other docs). `git add` only your files. Commit messages: `type(scope): summary`, body explaining why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Optional TTL on `InstanceState.make`

**Files:**
- Modify: `packages/flynncode/src/effect/instance-state.ts` (the `make` export, lines 26–45)
- Test: Create `packages/flynncode/test/effect/instance-state.test.ts`

**Interfaces:**
- Consumes: existing `ScopedCache.make` (Effect 4.0.0-beta.83) — it accepts `timeToLive?: Duration.Input | undefined` and re-runs `lookup` for a missing *or expired* entry (verified by probe).
- Produces: `make<A, E, R>(init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>, options?: { readonly timeToLive?: Duration.Input | undefined }): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope>` — back-compatible (second arg optional; callers unchanged).

- [ ] **Step 1: Write the failing tests**

Create `packages/flynncode/test/effect/instance-state.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { InstanceState } from "@/effect/instance-state"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("InstanceState ttl", () => {
  it.effect("rebuilds a state after the TTL expires", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        let builds = 0
        const state = yield* InstanceState.make<number>(() => Effect.sync(() => ++builds), { timeToLive: "5 minutes" })
        expect(yield* InstanceState.get(state)).toBe(1)
        expect(yield* InstanceState.get(state)).toBe(1)
        yield* TestClock.adjust(Duration.minutes(6))
        expect(yield* InstanceState.get(state)).toBe(2)
        expect(builds).toBe(2)
      }),
    ),
  )

  it.effect("keeps a state that is still fresh", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        let builds = 0
        const state = yield* InstanceState.make<number>(() => Effect.sync(() => ++builds), { timeToLive: "5 minutes" })
        yield* InstanceState.get(state)
        yield* TestClock.adjust(Duration.minutes(4))
        yield* InstanceState.get(state)
        expect(builds).toBe(1)
      }),
    ),
  )

  it.effect("states without a TTL never rebuild", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        let builds = 0
        const state = yield* InstanceState.make<number>(() => Effect.sync(() => ++builds))
        yield* InstanceState.get(state)
        yield* TestClock.adjust(Duration.hours(2))
        yield* InstanceState.get(state)
        expect(builds).toBe(1)
      }),
    ),
  )
})
```

- [ ] **Step 2: Run to verify the first test fails**

Run (from `packages/flynncode`): `bun test test/effect/instance-state.test.ts`
Expected: FAIL — TypeScript rejects the second argument (excess-argument error), so the tests do not compile/pass.

- [ ] **Step 3: Implement the TTL option**

In `packages/flynncode/src/effect/instance-state.ts`, add `Duration` to the first import and extend `make`:

```ts
import { Duration, Effect, ScopedCache, Scope } from "effect"
```

```ts
export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
  options?: { readonly timeToLive?: Duration.Input | undefined },
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
      // Optional TTL: after expiry the next get() rebuilds. For services whose
      // state embeds live external data (e.g. provider model discovery).
      timeToLive: options?.timeToLive,
    })

    const off = registerDisposer((directory) => Effect.runPromise(ScopedCache.invalidate(cache, directory)))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/flynncode`): `bun test test/effect/instance-state.test.ts`
Expected: 3 pass. Also run the neighboring service tests that use `InstanceState` to prove the back-compat default: `bun test test/effect/runtime-flags.test.ts` — pass.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/flynncode && bun typecheck
```

```bash
git add packages/flynncode/src/effect/instance-state.ts packages/flynncode/test/effect/instance-state.test.ts
git commit -m "feat(opencode): time-limited revalidation for instance state

InstanceState.make gains an optional timeToLive forwarded to ScopedCache.
A cached state that expires is rebuilt on the next get, so services whose
state embeds live external data (provider model discovery) can revalidate
without an instance reload. No behavior change for existing callers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Provider state freshness — connection events + TTL

**Files:**
- Modify: `packages/flynncode/src/provider/provider.ts`
  - imports near line 13–14: add `import { Integration } from "@flynncode/core/integration"`
  - near line 46: add the TTL constant next to `OPENCODE_HEADER_TIMEOUT_DEFAULT`
  - line 1469: pass the TTL as the second `InstanceState.make` argument (the call closes at lines 1886–1888: `      }),\n    )` becomes `      }),\n      { timeToLive: PROVIDER_STATE_TTL },\n    )`)
  - after the `ModelsDev.Event.Refreshed` subscription block (lines 2204–2208): add the `Integration.Event.ConnectionUpdated` subscription
- Test: Modify `packages/flynncode/test/provider/provider.test.ts`

**Interfaces:**
- Consumes: Task 1's `InstanceState.make` `timeToLive` option; `Integration` (`@flynncode/core/integration`) export shape `Event.ConnectionUpdated` (data `{ integrationID: number }`), `Integration.ID.make(id)`.
- Produces: no public interface change. `Provider.Service.list()` now reflects connection changes immediately and rebuilds after 5 minutes (the app's 5-minute provider poll and the plugin's catalog fetch both benefit). The constant is a file-local `const PROVIDER_STATE_TTL = "5 minutes"`.

- [ ] **Step 1: Write the failing tests**

In `packages/flynncode/test/provider/provider.test.ts` add the import next to the existing core imports (after `import { ModelsDev } from "@flynncode/core/models-dev"` at line 5):

```ts
import { Integration } from "@flynncode/core/integration"
```

Then, next to the existing `refreshedModels.instance("Meta discovery repeats after catalog refresh…")` test (lines 2533–2558), add:

```ts
refreshedModels.instance(
  "Meta discovery repeats when a provider connection changes",
  Effect.gen(function* () {
    const provider = (yield* list)[ProviderV2.ID.make("meta")]
    expect(provider.models["muse-wonder-full-1.0"]).toBeDefined()
    const before = discoveryModelsServer.metaRequests
    yield* list
    expect(discoveryModelsServer.metaRequests).toBe(before)
    const events = yield* EventV2.Service
    yield* events.publish(Integration.Event.ConnectionUpdated, { integrationID: Integration.ID.make("meta") })
    yield* pollWithTimeout(
      list.pipe(Effect.map(() => (discoveryModelsServer.metaRequests > before ? true : undefined))),
      "Meta model discovery did not rerun after a connection change",
    )
    expect(discoveryModelsServer.metaRequests).toBe(before + 1)
  }),
  {
    config: () => ({
      provider: {
        meta: {
          options: { apiKey: "meta-key", baseURL: discoveryModelsServer.url.replace("/v1", "/meta/v1") },
          models: metaDiscoveryModels,
        },
      },
    }),
  },
)

refreshedModels.effect(
  "Meta discovery repeats after the provider state TTL expires",
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const provider = (yield* list)[ProviderV2.ID.make("meta")]
        expect(provider.models["muse-wonder-full-1.0"]).toBeDefined()
        const before = discoveryModelsServer.metaRequests
        yield* list
        expect(discoveryModelsServer.metaRequests).toBe(before)
        yield* TestClock.adjust(Duration.minutes(10))
        yield* list
        expect(discoveryModelsServer.metaRequests).toBe(before + 1)
      }),
    {
      config: () => ({
        provider: {
          meta: {
            options: { apiKey: "meta-key", baseURL: discoveryModelsServer.url.replace("/v1", "/meta/v1") },
            models: metaDiscoveryModels,
          },
        },
      }),
    },
  ),
)
```

Also add the imports the new test needs at the top of the file (after the existing `testEffect` import line 13):

```ts
import * as TestClock from "effect/testing/TestClock"
import { provideTmpdirInstance } from "../fixture/fixture"
```

`Duration` is already imported in the file; if not, extend the `effect` import (line 4) with `Duration`.

- [ ] **Step 2: Run to verify they fail**

Run (from `packages/flynncode`): `bun test test/provider/provider.test.ts -t "repeats when a provider connection"` and `-t "provider state TTL"` (run once per filter or with both names: `bun test test/provider/provider.test.ts -t "Meta discovery repeats when a provider connection"` then `-t "Meta discovery repeats after the provider state TTL"`).
Expected: FAIL — the connection event does not trigger a rebuild (first test polls to timeout), and the TTL path does not exist (second test's rediscovery count stays `before`).

- [ ] **Step 3: Implement**

In `packages/flynncode/src/provider/provider.ts`:

1. Import (next to the `ModelsDev` import, line 13, and `EventV2`, line 14):

```ts
import { Integration } from "@flynncode/core/integration"
```

2. Constant near line 46:

```ts
// Provider state rebuilds on this clock so new/removed discovery results
// (e.g. Ollama pulls) surface without an instance reload. Matches the app's
// 5-minute provider poll.
const PROVIDER_STATE_TTL = "5 minutes"
```

3. TTL at line 1469 (the `make` call closing at 1886–1888):

```ts
    const state = yield* InstanceState.make<State>(
      () =>
        Effect.gen(function* () {
          // … existing body unchanged …
        }),
      { timeToLive: PROVIDER_STATE_TTL },
    )
```

4. Subscription right after the existing models.dev one (lines 2204–2208):

```ts
    // Integration connections move the connected set (vendor sign-in and
    // sign-out). Invalidate immediately instead of waiting for the TTL or
    // models.dev; layer-init fibers have no InstanceRef, so invalidateCurrent
    // drops every directory's cached state (same as the models.dev hook).
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.runForEach(() => InstanceState.invalidateCurrent(state)),
      Effect.forkScoped({ startImmediately: true }),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/flynncode`): `bun test test/provider/provider.test.ts`
Expected: the two new tests pass; the full provider suite stays green (discovery-caching tests that assert no repeat within an instance run on a live clock for well under 5 minutes with fresh tmpdir instances, so the TTL cannot fire inside them).

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/flynncode && bun typecheck
```

```bash
git add packages/flynncode/src/provider/provider.ts packages/flynncode/test/provider/provider.test.ts
git commit -m "feat(opencode): refresh provider state on connection events and ttl

provider.list served a snapshot built once per directory and only
re-invalidated by the hourly models.dev poll, so signing out of a vendor
kept it listed as connected and pulled models needed a restart. Subscribe
to Integration.Event.ConnectionUpdated and give the per-directory state a
5-minute TTL so provider.list() and the model router see the connected set
and discovery results change live.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Deliver global events to plugin hooks

**Files:**
- Modify: `packages/flynncode/src/plugin/index.ts` — the event listener (lines 283–291)
- Test: Modify `packages/flynncode/test/plugin/trigger.test.ts` (new `describe` at the end)

**Interfaces:**
- Consumes: existing `EventV2Bridge.Service` (`events.listen/publish`, location-less publish → global event), `Location.Info` / `Project.ID.make` / `AbsolutePath.make` from `@flynncode/core/location`, `@flynncode/core/project`, `@flynncode/core/schema`, `ModelsDev.Event.Refreshed` from `@flynncode/core/models-dev`.
- Produces: plugin `event` hooks receive location-less (global) v2 events; events scoped to another directory remain filtered. No API change.

- [ ] **Step 1: Write the failing tests**

At the end of `packages/flynncode/test/plugin/trigger.test.ts` (inside the file, after the `plugin.trigger` describe), add imports the new tests need:

```ts
import { ModelsDev } from "@flynncode/core/models-dev"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Location } from "@flynncode/core/location"
import { Project } from "@flynncode/core/project"
import { AbsolutePath } from "@flynncode/core/schema"
import { pollWithTimeout } from "../lib/effect"
```

and the describe:

```ts
describe("plugin event delivery", () => {
  const recorded = (test: { directory: string }, name: string) => {
    const file = path.join(test.directory, name)
    const read = Effect.gen(function* () {
      const text = yield* Effect.promise(() => Bun.file(file).text().catch(() => ""))
      return text
    })
    return { read, file }
  }

  const source = (eventsFile: string) =>
    [
      "export default async () => ({",
      `  event: async ({ event }) => {`,
      `    await Bun.write(${JSON.stringify(eventsFile)}, (event.type + " " + String(event.location?.directory ?? "global") + "\\n"), { append: true })`,
      `  },`,
      `})`,
      "",
    ].join("\n")

  // The listener registers during the Plugin.Service state build, which is
  // lazy per directory — force it with a harmless trigger before publishing.
  const loadHooks = Effect.gen(function* () {
    const pluginSvc = yield* Plugin.Service
    yield* pluginSvc.trigger("experimental.chat.system.transform", {}, { system: [] as string[] })
  })

  it.instance("location-less v2 events reach plugin event hooks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { read, file } = recorded(test, "events-global.txt")
      const bridge = yield* EventV2Bridge.Service
      yield* withProject(source(file), Effect.gen(function* () {
        yield* loadHooks
        yield* bridge.publish(ModelsDev.Event.Refreshed, {})
      }))
      yield* pollWithTimeout(
        Effect.flatMap(read, (text) => (text.includes("models-dev.refreshed") ? Effect.succeed(true) : Effect.succeed(undefined))),
        "plugin event hook never saw the location-less refresh event",
      )
    }),
  )

  it.instance("events scoped to another directory stay filtered", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { read, file } = recorded(test, "events-other.txt")
      const bridge = yield* EventV2Bridge.Service
      yield* withProject(source(file), Effect.gen(function* () {
        yield* loadHooks
        yield* bridge.publish(ModelsDev.Event.Refreshed, {}, {
          location: new Location.Info({
            directory: AbsolutePath.make("/other-directory"),
            project: { id: Project.ID.make("other-project"), directory: AbsolutePath.make("/other-directory") },
          }),
        })
      }))
      yield* Effect.sleep("300 millis")
      const text = yield* read
      expect(text).not.toContain("models-dev.refreshed")
    }),
  )
})
```

Note: `withProject(source, self)` takes the source and the effect to run once the plugin is registered (two arguments, matching the helper's signature at the top of the file). `Effect.sleep("300 millis")` is a bounded settle wait on the negative path in a `live` instance test; the positive path polls on a published signal, never a fixed sleep for readiness.

- [ ] **Step 2: Run to verify the first test fails**

Run (from `packages/flynncode`): `bun test test/plugin/trigger.test.ts`
Expected: FAIL — `plugin event hook never saw the location-less refresh event` (pollWithTimeout timeout), because the listener filter drops location-less events.

- [ ] **Step 3: Implement**

In `packages/flynncode/src/plugin/index.ts` change the listener (line 284):

```ts
        const unsubscribe = yield* events.listen((event) => {
          // Location-less events are global (models.dev refresh, integration
          // connections); instance plugins still need them. Events scoped to
          // another directory stay filtered.
          if (event.location?.directory !== undefined && event.location.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/flynncode`): `bun test test/plugin/trigger.test.ts test/plugin/ollama-model-router/plugin.test.ts`
Expected: all pass (both new delivery tests and the router plugin suite, which fires events directly against its own hook and is unaffected by the loader change).

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/flynncode && bun typecheck
```

```bash
git add packages/flynncode/src/plugin/index.ts packages/flynncode/test/plugin/trigger.test.ts
git commit -m "fix(opencode): deliver global events to plugin plugin hooks

Location-less v2 events (models.dev refresh, integration connections)
never reached instance plugin event hooks because the loader filtered on
exact directory equality. Keep filtering other directories and let
location-less events through, so plugins can invalidate on global signals.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Router plugin catalog — dirty flag + TTL

**Files:**
- Modify: `packages/flynncode/src/plugin/ollama-model-router/candidates.ts` (append the TTL helpers before the sentinel constants at the bottom, lines 174–181)
- Modify: `packages/flynncode/src/plugin/ollama-model-router/index.ts` (catalog block lines 36–65 and the `event` hook line 208–212)
- Test: Modify `packages/flynncode/test/plugin/ollama-model-router/candidates.test.ts` and `packages/flynncode/test/plugin/ollama-model-router/plugin.test.ts`

**Interfaces:**
- Consumes: Task 3 (the loader now delivers `integration.connection.updated` / `models-dev.refreshed` to the hook).
- Produces: exported from `candidates.ts`:
  - `CATALOG_TTL_MS = 5 * 60_000`
  - `catalogStale(loadedAt: number, now: number): boolean` — true when `now - loadedAt > CATALOG_TTL_MS`
  - `loadCatalog()` semantics (in `index.ts`, unchanged signature `() => Promise<void>`): refetches when nothing is cached, the cache is dirty (an invalidation event fired), or older than the TTL; concurrent callers share one in-flight fetch; a failed refetch keeps the last working snapshot and stays due for retry; a failed first load keeps the config-providers fallback.

- [ ] **Step 1: Write the failing tests**

Append to `packages/flynncode/test/plugin/ollama-model-router/candidates.test.ts` (import line: extend the existing import of the candidates module with `CATALOG_TTL_MS, catalogStale`):

```ts
describe("catalog staleness", () => {
  test("fresh inside the TTL window", () => {
    expect(catalogStale(0, CATALOG_TTL_MS)).toBe(false)
  })

  test("stale past the TTL window", () => {
    expect(catalogStale(0, CATALOG_TTL_MS + 1)).toBe(true)
  })

  test("never fresh at epoch origin without a load", () => {
    expect(catalogStale(0, 0)).toBe(false)
  })
})
```

Append to `packages/flynncode/test/plugin/ollama-model-router/plugin.test.ts`, inside the existing `describe("plugin")` block (after the last test, line 549, before the closing `})` at 550 — the `routeSentinel` helper defined at line 429 stays usable):

```ts
  describe("catalog freshness", () => {
    const connectedList = (connected: string[]) => ({
      all: [
        { id: "ollama-cloud", models: { a: {} } as Record<string, unknown> },
        { id: "anthropic", models: { "claude-fable-5-1": {} } as Record<string, unknown> },
      ],
      connected,
    })

    const catalogueOptions = {
      autoRoute: false,
      agentTasks: { build: "coding" },
      providers: ["anthropic", "ollama-cloud"],
      models: {},
    }

    const setup = async (client: any) => {
      const hooks = await plugin.server({ ...fakeInput, client }, catalogueOptions as any)
      await hooks.config?.({ provider: { "ollama-cloud": { models: { a: {} } }, "anthropic": { models: {} } } } as any)
      return hooks
    }

    test("chat.message refetches the catalog after integration.connection.updated", async () => {
      const lists = [connectedList(["ollama-cloud"]), connectedList(["ollama-cloud", "anthropic"])]
      let call = 0
      const hooks = await setup({
        provider: { list: async () => ({ data: lists[call++] ?? lists[lists.length - 1] }), },
      })
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({ providerID: "ollama-cloud", modelID: "a" })
      await hooks.event?.({ event: { id: "e", type: "integration.connection.updated", properties: {} } } as any)
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
      })
    })

    test("models-dev.refreshed still invalidates the catalog", async () => {
      let calls = 0
      const hooks = await setup({
        provider: { list: async () => { calls++; return { data: connectedList(["ollama-cloud", "anthropic"]) } } },
      })
      await routeSentinel(hooks, { provider: {} } as any)
      expect(calls).toBe(1)
      await hooks.event?.({ event: { id: "e", type: "models-dev.refreshed", properties: {} } } as any)
      await routeSentinel(hooks, { provider: {} } as any)
      expect(calls).toBe(2)
    })

    test("a failed refetch keeps the last working catalog and recovers on the next trigger", async () => {
      const lists: Array<unknown> = [connectedList(["ollama-cloud"]), new Error("boom"), connectedList(["ollama-cloud", "anthropic"])]
      let call = 0
      const hooks = await setup({
        provider: {
          list: async () => {
            const value = lists[call++]
            if (value instanceof Error) throw value
            return { data: value }
          },
        },
      })
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({ providerID: "ollama-cloud", modelID: "a" })
      await hooks.event?.({ event: { id: "e", type: "integration.connection.updated", properties: {} } } as any)
      // Refetch fails; routing still resolves against the retained catalog.
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({ providerID: "ollama-cloud", modelID: "a" })
      // Still dirty: the next routing refetches and picks up anthropic.
      expect(await routeSentinel(hooks, { provider: {} } as any)).toEqual({
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
      })
    })

    test("concurrent resolutions share one refetch", async () => {
      let calls = 0
      const hooks = await setup({
        provider: {
          list: async () => {
            calls++
            await Bun.sleep(2)
            return { data: connectedList(["ollama-cloud", "anthropic"]) }
          },
        },
      })
      const [one, two] = await Promise.all([
        routeSentinel(hooks, { provider: {} } as any),
        routeSentinel(hooks, { provider: {} } as any),
      ])
      expect(calls).toBe(1)
      expect(one).toEqual(two)
      await routeSentinel(hooks, { provider: {} } as any)
      expect(calls).toBe(1)
    })
  })
```

Ranking expectations in these tests rely on bundled scorecard entries: `DEFAULT_MODELS` carries `anthropic/claude-fable-5-1` at capability 8 / price 3 / speed 8, so with the coding weights (capability 0.7) it scores 7.5 versus 5.0 for the unscored neutral `ollama-cloud/a` (`allowUnscored` defaults to true, `DEFAULT_EXCLUDE_MODELS` only names xai entries).

- [ ] **Step 2: Run to verify failures**

Run (from `packages/flynncode`): `bun test test/plugin/ollama-model-router/plugin.test.ts -t "catalog freshness"` and `bun test test/plugin/ollama-model-router/candidates.test.ts`
Expected: FAIL — `catalogStale`/`CATALOG_TTL_MS` do not exist (candidates tests fail to import), and the catalog refetch tests fail (the current `loadCatalog` returns early once cached, so routing keeps `ollama-cloud/a`, no refetch happens).

- [ ] **Step 3: Implement**

`candidates.ts`, before the bottom sentinel constants:

```ts
// The plugin's catalog snapshot ages out after this long so silent external
// changes (auth set from a CLI, pulled models) revalidate within a bound;
// invalidation events cover the moment they happen.
export const CATALOG_TTL_MS = 5 * 60_000

export function catalogStale(loadedAt: number, now: number): boolean {
  return now - loadedAt > CATALOG_TTL_MS
}
```

`index.ts` — replace the catalog block (lines 36–65, `let catalog … const clearCatalog = () => { catalog = undefined }`) with:

```ts
  // The connected catalog (models.dev providers resolved by the server) is the
  // same source the model picker uses. Raw config is the fallback so headless
  // and unit-test callers keep working. Only `connected` providers count for
  // family resolution — the full models.dev `all` list includes providers the
  // user has no credentials for, which would make every family look available.
  // The snapshot is versioned: invalidation events mark it dirty and it ages
  // out after CATALOG_TTL_MS, so routing and tools see vendor connect/disconnect
  // and pulled models within a bounded window instead of a process-lifetime
  // snapshot.
  let catalog: CatalogLike | undefined
  let catalogLoadedAt = 0
  let catalogDirty = true
  let refetching: Promise<void> | undefined
  const getCatalog = (): CatalogLike | undefined => catalog
  const loadCatalog = async () => {
    if (catalog && !catalogDirty && !catalogStale(catalogLoadedAt, Date.now())) return
    // One fetch serves concurrent resolutions (prompt-time routing and tools).
    if (refetching) return refetching
    refetching = (async () => {
      try {
        const result = await input.client.provider.list()
        const all = result.data?.all ?? []
        const connected = new Set(result.data?.connected ?? [])
        catalog = Object.fromEntries(
          all
            .filter((provider: any) => connected.has(provider.id))
            .map((provider: any) => [provider.id, { name: provider.name, models: provider.models ?? {} }]),
        ) as CatalogLike
        catalogLoadedAt = Date.now()
        catalogDirty = false
      } catch (error) {
        // A failed refetch keeps the last working snapshot (stale beats
        // nothing) and stays due for retry; a failed first load falls back to
        // config providers until one succeeds.
        console.warn(`${PREFIX} connected catalog unavailable; using config providers`, error)
      } finally {
        refetching = undefined
      }
    })()
    return refetching
  }
```

Add `catalogStale` to the candidates import (line 3):

```ts
import {
  catalogStale,
  ROUTER_MODEL_ID,
  ROUTER_PROVIDER_ID,
  type CatalogLike,
} from "./candidates"
```

Replace the `event` hook (lines 208–212):

```ts
    event: async ({ event }) => {
      // The v1 Event union cannot express models-dev.refreshed or
      // integration.connection.updated (v2 events delivered over the shared
      // bus), so narrow at runtime. Both are location-less (global).
      const type = (event as { type?: string }).type
      if (type === "models-dev.refreshed" || type === "integration.connection.updated") catalogDirty = true
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/flynncode`): `bun test test/plugin/ollama-model-router`
Expected: all pass (the existing 7 suites plus the new candidates + plugin tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/flynncode && bun typecheck
```

```bash
git add packages/flynncode/src/plugin/ollama-model-router/candidates.ts packages/flynncode/src/plugin/ollama-model-router/index.ts packages/flynncode/test/plugin/ollama-model-router/candidates.test.ts packages/flynncode/test/plugin/ollama-model-router/plugin.test.ts
git commit -m "feat(plugin): refresh the model router catalog on connection changes

The router cached its connected-provider catalog once per instance, so a
vendor signed in mid-session never joined the routing pool and a signed-out
vendor kept being routed into until the (previously dead) hourly refresh
fired. Versioned the snapshot: invalidation events mark it dirty and it
ages out after 5 minutes, with one shared in-flight refetch and a
keep-last-good failure path.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Manage Models visibility write-through

**Files:**
- Modify: `packages/app/src/context/models.tsx` (init body: two exported pure helpers + the write-through in `setVisibility`)
- Test: Create `packages/app/src/context/model-visibility-sync.test.ts`
- Modify: `packages/app/src/i18n/en.ts` (one new key) and `packages/app/src/i18n/flynncode-fallback.ts` (append the same key to `keys`)

**Interfaces:**
- Consumes: `useServerSync()` (`serverSync().data.config`, `serverSync().updateConfig(patch)` — same write path as the router editor: `PATCH /global/config`), `showToast` from `@/utils/toast`, `useLanguage()`.
- Produces: exported from `models.tsx`:
  - `visibilityExcludeKeys(rows: Array<{ providerID: string; modelID: string; visibility: "show" | "hide" }>): string[]` — `"providerID/modelID"` for explicit hides only
  - `visibilityUnchanged(current: unknown, hidden: string[]): boolean` — set-level equality, ignores non-string/current-undefined
  - i18n key `settings.models.visibilitySyncFailed.title` = `"Could not sync model visibility"`

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/context/model-visibility-sync.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { visibilityExcludeKeys, visibilityUnchanged } from "./models"

describe("visibility exclude mirror", () => {
  test("mirrors explicit hides only", () => {
    const rows: Array<{ providerID: string; modelID: string; visibility: "show" | "hide" }> = [
      { providerID: "anthropic", modelID: "claude-sonnet-5", visibility: "show" },
      { providerID: "anthropic", modelID: "claude-opus-5", visibility: "hide" },
      { providerID: "openai", modelID: "gpt-6-sol", visibility: "hide" },
    ]
    expect(visibilityExcludeKeys(rows)).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-6-sol",
    ])
  })

  test("empty store produces an empty mirror", () => {
    expect(visibilityExcludeKeys([])).toEqual([])
  })

  test("unchanged when the configured list matches as a set", () => {
    expect(visibilityUnchanged(["openai/gpt-6-sol", "anthropic/claude-opus-5"], ["anthropic/claude-opus-5", "openai/gpt-6-sol"])).toBe(true)
  })

  test("changed when the list differs, or is undefined/non-string", () => {
    expect(visibilityUnchanged(["openai/gpt-6-sol"], [])).toBe(false)
    expect(visibilityUnchanged(undefined, [])).toBe(false)
    expect(visibilityUnchanged(["openai/gpt-6-sol", 42], ["openai/gpt-6-sol"])).toBe(false)
    expect(visibilityUnchanged(["openai/gpt-6-sol"], ["openai/gpt-6-sol"])).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/app`): `bun test --conditions=solid --preload ./happydom.ts src/context/model-visibility-sync.test.ts`
Expected: FAIL — the exports do not exist yet (import error).

- [ ] **Step 3: Implement the helpers and write-through**

In `packages/app/src/context/models.tsx`:

1. Extend imports:

```ts
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { onCleanup } from "solid-js"
```

2. Add the exported pure helpers near the existing `modelKey` helper (top of the file):

```ts
// The router (server plugin) cannot read this client-side visibility store,
// so the mirror it consumes is explicit hides as `model_router.excludeModels`.
export function visibilityExcludeKeys(
  rows: Array<{ providerID: string; modelID: string; visibility: Visibility }>,
): string[] {
  return rows.filter((row) => row.visibility === "hide").map((row) => `${row.providerID}/${row.modelID}`)
}

// Set-level comparison: user rows and the config list can differ in order;
// non-string config entries count as different (a corrupt list must be
// rewritten, not adopted).
export function visibilityUnchanged(current: unknown, hidden: string[]): boolean {
  if (!Array.isArray(current) || current.length !== hidden.length) return false
  const left = current.filter((key): key is string => typeof key === "string").sort()
  const right = [...hidden].sort()
  return left.every((key, index) => key === right[index])
}
```

3. In the context init, after the store is created (line 38) and before `available`, add:

```ts
    // Manage Models hides sync to the server as `model_router.excludeModels`
    // (the merge swaps `model_router` whole, so the patch carries the current
    // router object with excludeModels replaced). Debounced trailing: a
    // quick pass toggling several models writes once. A no-op (the config
    // already matches) never writes, so selecting an already-visible model
    // does not rebuild instances.
    const serverSync = useServerSync()
    const language = useLanguage()
    let visibilitySync: ReturnType<typeof setTimeout> | undefined
    onCleanup(() => clearTimeout(visibilitySync))
    const syncVisibility = () => {
      clearTimeout(visibilitySync)
      visibilitySync = setTimeout(() => {
        const hidden = visibilityExcludeKeys(store.user)
        // Same cast the router settings editor uses for the config's
        // model_router block (packages/app/src/components/settings-v2/model-router.tsx).
        const config = serverSync().data.config as
          | { model_router?: { excludeModels?: unknown } }
          | undefined
        const router = config?.model_router
        if (visibilityUnchanged(router?.excludeModels, hidden)) return
        const patch: Record<string, unknown> = { model_router: { ...(router ?? {}), excludeModels: hidden } }
        void serverSync()
          .updateConfig(patch)
          .catch(() => showToast({ variant: "error", title: language.t("settings.models.visibilitySyncFailed.title") }))
      }, 300)
    }
```

4. Change `setVisibility` (line 126):

```ts
    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
      syncVisibility()
    }
```

(Selecting a model routes through `local.tsx` `applySet` → `models.setVisibility(item, true)`; a selection that does not change the hidden set is a no-op write, so no instance rebuild.)

5. Add the i18n key. In `packages/app/src/i18n/en.ts`, next to `"settings.models.title": "Models",` (line ~1680):

```ts
  "settings.models.visibilitySyncFailed.title": "Could not sync model visibility",
```

And append the same key string to the `keys` array in `packages/app/src/i18n/flynncode-fallback.ts` (keep alphabetical order within the settings block):

```ts
  "settings.models.visibilitySyncFailed.title",
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/app`): `bun test --conditions=solid --preload ./happydom.ts src/context/model-visibility-sync.test.ts src/context/model-variant.test.ts`
Expected: both pass (the variant test exercises the models context path and must stay green).

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/app && bun typecheck
```

```bash
git add packages/app/src/context/models.tsx packages/app/src/context/model-visibility-sync.test.ts packages/app/src/i18n/en.ts packages/app/src/i18n/flynncode-fallback.ts
git commit -m "feat(app): write manage-models visibility to router exclusions

Manage Models visibility was client-side only and reached the server model
router only via a later Save in the router settings editor. Mirror explicit
hides into global config as model_router.excludeModels, debounced and
no-op-aware so nothing rebuilds unless the hidden set changed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Router editor passes the server's exclusions through

**Files:**
- Modify: `packages/app/src/components/settings-v2/model-router.tsx` (remove `inScope` + `excludeSnapshot` lines 132–141; rework `save()` lines 143–174)
- Test: Modify `packages/app/e2e/regression/model-router.spec.ts` (the test at line 153 asserts the snapshot; it must assert the new pass-through behavior) — run e2e typecheck; full e2e execution if the local setup supports it (`bun run e2e` or the repo's Playwright task — check `packages/app/package.json` scripts).

**Interfaces:**
- Consumes: Task 5 semantics (`excludeModels` = server-side mirror of explicit hides, updated live); `routerConfig()` (already in the component, line 41).
- Produces: save payload keeps `model_router` whole-swapped with the server's current `excludeModels` value passed through verbatim; editor Save can no longer overwrite live Manage Models changes.

- [ ] **Step 1: Update the failing e2e**

In `packages/app/e2e/regression/model-router.spec.ts` replace the test at line 153 (`hidden models leave every list and are snapshotted as exclusions on save`) with two tests:

```ts
test("hidden models leave every list and a clean save does not write exclusions", async ({ page }) => {
  const { router, state } = await openRouter(page, {
    visible: [["ollama-local", "smart"]],
  })
  await router.getByRole("tab", { name: "Routing", exact: true }).click()
  const coding = router.getByRole("article", { name: "Coding", exact: true })
  const select = coding.getByRole("combobox", { name: "Model for Coding", exact: true })
  await expect(select.locator("option", { hasText: "Fast model" })).toHaveCount(0)
  await expect(select.locator("option", { hasText: "Smart model" })).toHaveCount(1)
  await router.getByRole("tab", { name: "Models", exact: true }).click()
  await router.getByRole("button", { name: "Add models", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Add models", exact: true })
  await expect(picker.getByRole("checkbox", { name: "Fast model", exact: true })).toHaveCount(0)
  await expect(picker.getByRole("checkbox", { name: "Smart model", exact: true })).toBeEnabled()
  await picker.getByRole("button", { name: "Cancel", exact: true }).click()
  // A dirtying edit lets Save run (an unchanged form keeps it disabled).
  await router.getByRole("tab", { name: "Routing", exact: true }).click()
  await coding.getByRole("combobox", { name: "Priority for Coding", exact: true }).selectOption("speed")
  await router.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  // Manage Models visibility now writes through to config; the editor Save
  // must not re-derive a snapshot of its own.
  expect(state.writes[0].model_router).not.toHaveProperty("excludeModels")
})

test("save keeps the server's configured exclusions untouched", async ({ page }) => {
  const { router, state } = await openRouter(page, {
    config: { providers: ["ollama-local"], excludeModels: ["ollama-local/fast"] },
  })
  await router.getByRole("tab", { name: "Routing", exact: true }).click()
  const coding = router.getByRole("article", { name: "Coding", exact: true })
  await coding.getByRole("combobox", { name: "Priority for Coding", exact: true }).selectOption("speed")
  await router.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0].model_router).toMatchObject({ excludeModels: ["ollama-local/fast"] })
})
```

(The configured `excludeModels` must survive a Save verbatim; a dirtying taskWeights edit makes Save clickable. If the current "Add models" interaction in the original test leaves the form non-dirty, the priority select above is what enables Save — mirror the first e2e test at line 138.)

(Run the e2e suite when the local Playwright setup is available; at minimum the e2e TypeScript must typecheck. The first test should FAIL before the editor change because today's Save writes the release-stale snapshot into `excludeModels`.)

- [ ] **Step 2: Run to verify the first e2e fails today**

Run: the e2e depends on the Playwright server; if the environment cannot run browsers, record that and rely on the unit/typecheck gates plus manual verification later. Expected (when runnable): the first test fails on `not.toHaveProperty("excludeModels")` because the current `excludeSnapshot()` write lands.

- [ ] **Step 3: Implement the pass-through**

In `packages/app/src/components/settings-v2/model-router.tsx`:

1. Delete `inScope` and `excludeSnapshot` (lines 132–141 including the comment above `excludeSnapshot`).

2. Replace the top of `save()` (lines 143–146):

```ts
  // excludeModels is owned by Manage Models visibility, mirrored into config
  // live. Pass the server's current list through so a Save cannot clobber
  // live changes with a stale load-time snapshot.
  const serverExcludeModels = () => {
    const raw = (routerConfig()?.excludeModels as unknown) ?? []
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : []
  }

  const save = async () => {
    if (state.saving || invalid()) return
    const excludeModels = serverExcludeModels()
    const result = validateForm({ ...form, excludeModels })
```

3. In the success callback (line 168), keep the form in sync with what was saved:

```ts
          setForm("excludeModels", excludeModels)
```

- [ ] **Step 4: Verify**

Run (from `packages/app`): `bun run typecheck` — pass. Run e2e if available: `bun run e2e -- --grep "model-router"` (or the command in `packages/app/package.json`; verify it exists first) — the two rewritten tests pass and the untouched tests (bulk save / pin) still pass.

Run the payload and contract suites: `bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/model-router-payload.test.ts` and `bun test --conditions=browser --preload ./happydom.ts test-browser/model-router-contract.test.ts` — both pass unchanged (they test the payload/preview contract, which keeps `excludeModels` support; only the writer changed).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/model-router.tsx packages/app/e2e/regression/model-router.spec.ts
git commit -m "feat(app): router editor passes server exclusions through

Manage Models visibility now maintains model_router.excludeModels itself,
so the editor's Save must not re-snapshot the visibility store (which
covers release-stale defaults, not just explicit hides): a stale snapshot
could clobber the server list. Save now writes the server's current list
through verbatim.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Docs and end-to-end verification

**Files:**
- Modify: `packages/flynncode/src/plugin/ollama-model-router/README.md`

- [ ] **Step 1: Update the README**

Replace the `excludeModels` bullet (lines 52–54) with:

```markdown
- `excludeModels` lists `providerID/modelID` pairs the router must skip. Manage
  Models visibility writes it into the config live (explicit hides only), and
  the router settings editor passes the server's current list through on Save.
```

And add a freshness section after the `enabled` bullets (after line 51):

```markdown
- The router keeps its model list live: it refetches the connected catalog
  when a provider connects or disconnects (`integration.connection.updated`)
  or models.dev refreshes (`models-dev.refreshed`), and revalidates at most
  every 5 minutes otherwise. Silent external changes (e.g. `opencode auth
  login` in another process, pulled models) surface within that window.
```

- [ ] **Step 2: Full verification pass**

```bash
cd packages/flynncode && bun test test/effect/instance-state.test.ts test/effect/runtime-flags.test.ts test/plugin/ollama-model-router test/plugin/trigger.test.ts test/provider/provider.test.ts
cd packages/flynncode && bun typecheck
cd packages/app && bun run test:unit
cd packages/app && bun run test:browser
cd packages/app && bun typecheck
```

Expected: all green. Fix fallout in the package that failed it (a failing provider test about exact discovery counts should be checked against the TTL — remember `it.instance` tests run on a live clock with fresh instances, so a >5-minute suite run inside ONE instance context is the only way the TTL can bite; if the app/server integration suites share one long-lived instance and fail on discovery-count assertions, mark those assertion sites to tolerate a re-count only at a clock-expiry boundary by asserting counts monotonic-ly (`toBeGreaterThanOrEqual`) — do NOT weaken unrelated assertions without a comment explaining the TTL revalidation).

- [ ] **Step 3: Commit**

```bash
git add packages/flynncode/src/plugin/ollama-model-router/README.md
git commit -m "docs(plugin): document live model-list freshness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Risk notes for executors

- Task 2's TTL rebuild re-runs plugin auth loading and SDK construction when it fires; it is read-by-read lazy (no background timer), so prompt latency is unaffected except on the first call after expiry.
- Task 3 widens what plugin event hooks can see (global events). Third-party plugins that ignore unknown types are unaffected.
- Task 5 makes a Manage Models toggle rebuild instances (same cost as a router-editor Save today) — the debounce keeps it to at most one rebuild per burst, ~300 ms apart.
- If `Integration.Event.ConnectionUpdated` never reaches the Provider subscription in tests, check that the subscription fiber is in the same layer as `EventV2.Service` used by the test publish (the `refreshedModels` runner pattern from line 2533 covers this; the memoMap dedupes the service).