# Upstream Sync (opencode dev → flynncode dev) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the upstream OpenCode fixes that the Flynncode fork still lacks — provider error classification, agent-model fallback, plugin-activation ordering, MCP robustness, and the desktop/theme corrections — without importing upstream's parallel V2 rewrite.

**Architecture:** The fork is a *parallel* fork, not a stale clone: `packages/core` (298 diverged + 479 upstream-only files), `packages/app` (90/719), `packages/ai`→`packages/llm` (104/594) and `packages/tui` (127/362) have diverged structurally. Upstream's own V2 session/app/llm rewrite is therefore **not** portable and must never be merged wholesale. Every task below ports *behaviour* into the fork's own architecture — its `packages/llm` route/protocol layer, its `packages/core` V2 session runner, its `packages/flynncode/src/mcp` module and its own `PluginV2` service — and is verified with a test that fails before the change.

**Tech Stack:** Bun 1.3.14, Effect v4 (`effect@4.0.0-beta.83`, `effect/unstable/http`), Effect Schema, `bun:test`, drizzle-orm, Electron + electron-builder, SolidJS.

**Spec:** This document. Upstream reference commits are named per task; the review that produced the shortlist is recorded in `.opencode/tmp/upstream-review/` (scratch, not committed).

## Global Constraints

- Branch name: short, hyphen-separated, at most three words (`upstream-sync`, `provider-errors`, `plugin-activation`).
- Commit messages: conventional style `type(scope): summary` with `type` in `feat|fix|docs|chore|refactor|test`.
- **Never** merge or cherry-pick `upstream/dev` as a whole. Port behaviour per task.
- **Never** vendor upstream binaries, releases, or `@opencode-ai/cli` downloads.
- Product name in user-visible copy is **Flynncode**; the CLI package is `packages/flynncode`; the provider package is `packages/llm`. Upstream's `packages/ai` maps to `packages/llm`, upstream's `packages/cli` maps to `packages/flynncode`.
- Tests never run from the repo root (guard: `do-not-run-tests-from-root`). Run from the package directory.
- Typecheck with `bun typecheck` from the package directory. Never bare `tsc`.
- Do not edit `packages/client/src/generated` or `packages/client/src/generated-effect` by hand; regenerate with `bun run generate` from `packages/client` if the public Protocol or Server `HttpApi` changes.
- No new comments explaining obvious code. Comments only for non-obvious constraints (e.g. *why* a provider phrase is classified a certain way).
- Never hardcode user-visible English strings in desktop production code (use i18n keys).

## Review Focus

Input classes and failure modes the spec implies but no task's test exercises outright — most likely to bite a real user first:

1. **A provider reports an invalid API key as HTTP 400 with a body code (not 401).** The user should be told to check the key, not shown a generic "invalid request". → Task 1.
2. **A provider reports the request body as too large (HTTP 413 / "request entity too large").** Compaction cannot fix this; the session must not burn a compaction cycle and then fail anyway. → Task 1.
3. **A tool call arrives while a plugin reload is in flight.** The permission check reads the session's agent; if it reads a half-reloaded agent the wrong tool may be allowed or a valid one denied. → Task 4.
4. **A session is started with an agent that names a model, and the session itself has no model.** The agent's model must win over the catalog default. → Task 2.
5. **Two MCP servers use different OAuth callback ports.** The second server's callback server replaces the first, so the first login never completes and hangs until its 5-minute timeout. → Task 5.
6. **An MCP tool call blocks for more than five minutes.** Bun's fetch idle deadline aborts the request mid-call even though the MCP execution timeout has not fired. → Task 6.
7. **A user installs the RPM on a machine that also has another Electron RPM.** Identical bundled Electron binaries produce identical `/usr/lib/.build-id` links, and rpm/zypper then refuse to install or update. → Task 8.
8. **A theme's foreground/background pair is checked for contrast.** The relative-luminance green coefficient is wrong, so a pair that fails WCAG passes the check. → Task 9.

---

### Task 1: Provider error classification

Port upstream's provider-error evidence gathering into `packages/llm`. The fork already has the full error taxonomy (`AuthenticationReason`, `RateLimitReason`, `QuotaExceededReason`, `ContentPolicyReason`, `ProviderInternalReason`, `UnknownProviderReason`) but classifies failures by HTTP status only, and its context-overflow pattern list is missing eight provider wordings.

**Files:**
- Modify: `packages/llm/src/provider-error.ts`
- Modify: `packages/llm/src/schema/errors.ts` (`ProviderFailureClassification` literal list)
- Modify: `packages/llm/src/route/executor.ts` (`statusReason`, lines 228–290)
- Modify: `packages/llm/src/index.ts` (barrel exports)
- Test: `packages/llm/test/provider-error.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `isPayloadTooLarge(message: string): boolean` — new export in `packages/llm/src/provider-error.ts`.
  - `providerCodes(value: unknown): string[]` — new export; lowercased provider error codes found in a decoded JSON body, a raw string body, or a message. Returns `[]` for non-JSON input.
  - `classifyInvalidRequest(message: string): "context-overflow" | "repetitive-content" | "payload-too-large" | undefined` — existing signature, new member.
  - `ProviderFailureClassification` gains the literal `"payload-too-large"`.
  - `classifyProviderFailure(input: ProviderFailure)` — new export returning the fork's reason union (`InvalidRequestReason | AuthenticationReason | RateLimitReason | QuotaExceededReason | ContentPolicyReason | ProviderInternalReason | UnknownProviderReason`), where
    ```ts
    export interface ProviderFailure {
      readonly message: string
      readonly status: number
      readonly body: string
      readonly retryAfterMs?: number | undefined
      readonly rateLimit?: HttpRateLimitDetails | undefined
      readonly http: HttpContext
    }
    ```
    `ProviderFailure` is exported from `packages/llm/src/provider-error.ts` and imports `HttpContext` / `HttpRateLimitDetails` from `./schema`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/llm/test/provider-error.test.ts`:

```ts
describe("provider context-overflow wordings", () => {
  test("recognises provider-specific overflow wordings", () => {
    const messages = [
      "Requested input length 3500 exceeds maximum input length 2048",
      "input is longer than the model's context length",
      "number of input tokens exceeds maximum length",
      "Prompt exceeds max length",
      "Prompt 超长",
      "`inputs` tokens + `max_new_tokens` must be <= 4096",
      "exceeded this model context window limit",
      "too large for the model's configured input limit",
      "range of input length should be within the limit",
    ]
    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("does not treat a payload-too-large body as a context overflow", () => {
    expect(isContextOverflow("request entity too large")).toBe(false)
    expect(isContextOverflow("payload too large")).toBe(false)
    expect(isPayloadTooLarge("request entity too large")).toBe(true)
    expect(isPayloadTooLarge("payload too large")).toBe(true)
    expect(classifyInvalidRequest("request entity too large")).toBe("payload-too-large")
  })

  test("keeps the compact-worthy transcript classification", () => {
    const message = "Invalid request: input[3485].call_id The length of the value must be `<= 64`."
    expect(classifyInvalidRequest(message)).toBe("repetitive-content")
  })

  test("does not classify an output-limit rejection as a context overflow", () => {
    expect(isContextOverflow("max_tokens must be less than the model maximum")).toBe(false)
  })
})

describe("provider codes", () => {
  test("reads codes from common error body shapes", () => {
    expect(providerCodes('{"code":"context_length_exceeded"}')).toContain("context_length_exceeded")
    expect(providerCodes('{"error":{"code":"invalid_api_key","type":"invalid_request_error"}}')).toContain(
      "invalid_api_key",
    )
    expect(providerCodes("not json")).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm && bun test test/provider-error.test.ts`
Expected: FAIL — `isPayloadTooLarge` and `providerCodes` are not exported, and the eight provider wordings are not recognised.

- [ ] **Step 3: Expand the classification in `packages/llm/src/provider-error.ts`**

Replace the `patterns` array with the union of the fork's current patterns and upstream's (`git show upstream/dev:packages/ai/src/provider-error.ts` lines 9–66). Upstream's additions, each with the provider it covers:

- `/input is too long for (?:the )?(?:requested|selected) model/i`
- `/too large for the model'?s configured input limit/i` (OpenCode Go)
- `/exceeded this model context window limit/i` (Cloudflare Workers AI)
- `/number of input tokens exceeds maximum length/i` (Amazon Nova on Bedrock)
- `/requested input length \d+ exceeds maximum input length/i` (DeepInfra)
- `/input(?: \(\d+ tokens\))? is longer than the model'?s context length/i` (Novita, no token counts)
- `/`inputs` tokens \+ `max_new_tokens` must be <= \d+/i` (Hugging Face TGI / Together)
- `/prompt (?:too long|exceeds max length|超长)/i` (Z.ai)
- `/range of input length should be/i`
- `/request_too_large/i`

Remove `/request entity too large/i` and `/prompt too long; exceeded (?:max )?context length/i` from the context-overflow list — upstream moved them to the payload list because a large *body* is not a context-window problem.

Add to `exclusions`: `/max[_ ]tokens must be less than/i` (Cohere reports an output limit above the model maximum as "too many tokens"; compaction cannot fix it).

Add:

```ts
const payloadPatterns = [/request entity too large/i, /payload too large/i, /request too large/i]

export const isPayloadTooLarge = (message: string) => payloadPatterns.some((pattern) => pattern.test(message))
```

Change `classifyInvalidRequest` to return `"payload-too-large"` when `isPayloadTooLarge(message)` and the message is not a context overflow, keeping `"context-overflow"` and `"repetitive-content"` ahead of it in that order.

Add `providerCodes(value: unknown): string[]`: when `value` is a string, decode it with `Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))`; when the decoded value is a record, collect the lowercased string values of `decoded.code`, `decoded.error_type`, `decoded.error.code`, `decoded.error.type`, `decoded.type`, and — for Azure-shaped bodies — `decoded.error.innererror.code`. Return `[]` when nothing matches.

- [ ] **Step 4: Add the `payload-too-large` literal**

In `packages/llm/src/schema/errors.ts`, change:

```ts
export const ProviderFailureClassification = Schema.Literals(["context-overflow", "repetitive-content"])
```

to:

```ts
export const ProviderFailureClassification = Schema.Literals([
  "context-overflow",
  "repetitive-content",
  "payload-too-large",
])
```

- [ ] **Step 5: Add `classifyProviderFailure` to `packages/llm/src/provider-error.ts`**

Implement `classifyProviderFailure(input: ProviderFailure)` returning the fork's reason union, in this order:

1. If `providerCodes` of `input.body` contains `context_length_exceeded` or `model_context_window_exceeded`, or `isContextOverflow(input.body + "\n" + input.message)` → `new InvalidRequestReason({ message, classification: "context-overflow", http })`.
2. Else if `input.status === 413` or `isPayloadTooLarge(text)` → `new InvalidRequestReason({ message, classification: "payload-too-large", http })`.
3. Else if the body or message matches the existing content-policy regex (`/content[-_\s]?policy|content_filter|safety/i`) → `new ContentPolicyReason({ message, http })`.
4. Else if `input.status === 402`, or the codes contain a quota code (`insufficient_quota`, `quota_exceeded`, `billing_hard_limit_reached`), or `input.status === 429` and the body matches `/insufficient[-_\s]?quota|quota[-_\s]?exceeded/i` → `new QuotaExceededReason({ message, http })`.
5. Else if `input.status === 401` → `new AuthenticationReason({ message, kind: "invalid", http })`; `403` → `kind: "insufficient-permissions"`; or `input.status === 400` and the codes contain an auth code (`invalid_api_key`, `authentication_error`, `invalid_authentication`, `unauthorized`) → `kind: "invalid"`.
6. Else if `input.status === 429` or the codes contain a rate-limit code (`rate_limit_exceeded`, `too_many_requests`, `throttlingexception`) or the text matches `/rate limit|too many requests|throttl/i` → `new RateLimitReason({ message, retryAfterMs, rateLimit, http })`.
7. Else if `input.status >= 500` → `new ProviderInternalReason({ message, status, retryAfterMs, http })`.
8. Else if `input.status >= 400` → `new InvalidRequestReason({ message, classification: classifyInvalidRequest(input.body), http })`.
9. Else → `new UnknownProviderReason({ message, status: input.status, http })`.

Step 5's step-8 branch must preserve the existing behaviour that a 400 with an unrecognised body yields `classification: undefined` (the existing test "unrelated 400s stay unclassified" pins this).

- [ ] **Step 6: Route the executor through `classifyProviderFailure`**

In `packages/llm/src/route/executor.ts`, delete the `statusReason` function (lines 228–290) and replace its call site in `statusError` with:

```ts
return yield* new LLMError({
  module: "RequestExecutor",
  method: "execute",
  reason: classifyProviderFailure({
    status: response.status,
    message: providerMessage(response.status, details),
    body: details.body ?? "",
    retryAfterMs: retryAfter,
    rateLimit,
    http: responseHttp({ request, response, redactedNames, body: details, requestId, rateLimit }),
  }),
})
```

Import `classifyProviderFailure` from `../provider-error` and drop the now-unused reason-class imports (`ContentPolicyReason`, `AuthenticationReason`, `QuotaExceededReason`, `RateLimitReason`, `InvalidRequestReason`, `ProviderInternalReason`, `UnknownProviderReason`, `classifyInvalidRequest`) from that file — keep any that are still referenced elsewhere in the file.

- [ ] **Step 7: Export the new helpers**

In `packages/llm/src/index.ts`, extend the `./provider-error` export line to include `isPayloadTooLarge`, `providerCodes` and `classifyProviderFailure`, and export the `ProviderFailure` type.

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd packages/llm && bun test test/provider-error.test.ts`
Expected: PASS (all pre-existing assertions plus the new ones).

- [ ] **Step 9: Run the whole package suite and typecheck**

Run: `cd packages/llm && bun test` — Expected: PASS.
Run: `cd packages/llm && bun typecheck` — Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/llm
git commit -m "fix(llm): classify provider errors from codes and widen context-overflow coverage"
```

---

### Task 2: Prefer the agent's model when the session has none

The fork's `SessionRunnerModel` ignores `Agent.Info.model` when `session.model` is undefined and falls back to the catalog default. `packages/core/src/config/plugin/agent.ts:91-97` writes `agent.model` from the agent config, and no production code reads it back — so an agent that names a model never gets it.

**Files:**
- Modify: `packages/core/src/session/runner/model.ts` (`locationLayer`, lines 181–216; `node`, line 218)
- Test: `packages/core/test/session-runner-model.test.ts`

**Interfaces:**
- Consumes: `AgentV2.Service.select(id?: ID | string): Effect.Effect<Selection>` from `packages/core/src/agent.ts` (returns `{ id, info }`, `info.model` is `Model.Ref | undefined`); `catalog.model.available(): Effect.Effect<ModelV2.Info[]>`; `catalog.model.get(providerID, modelID): Effect.Effect<ModelV2.Info | undefined>`.
- Produces: no new exported names. `SessionRunnerModel.Interface.resolve` keeps its signature; its behaviour changes so the agent's model wins.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/session-runner-model.test.ts` a case that builds a session with `model: undefined`, registers an agent whose `info.model` is `{ providerID, id, variant }`, and asserts that `resolve` selects that provider/id rather than the catalog default.

Read `packages/core/test/session-runner-model.test.ts` first and follow its existing fixtures: it already provides a `Catalog` and an `Integration` service and calls `SessionRunnerModel.Service`. Add the agent to the same layer group.

Assertions to pin:
- The resolved model comes from the agent's `providerID`/`id`.
- The resolved model uses the **agent's** variant, not the session's (the session has no model, so `session.model?.variant` is `undefined`).
- When the agent names a model that is **not** in `catalog.model.available()`, resolution falls back to the current behaviour (catalog default) — it must not fail with `ModelUnavailableError`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && bun test test/session-runner-model.test.ts`
Expected: FAIL — the resolved model is the catalog default, not the agent's.

- [ ] **Step 3: Implement the agent-model preference**

In `packages/core/src/session/runner/model.ts`:

- Add `AgentV2` to the imports: `import { AgentV2 } from "../../agent"`.
- In `locationLayer`, add `const agents = yield* AgentV2.Service` next to `catalog` and `integrations`.
- Change the `resolve` body so that, when `session.model` is undefined, it first looks for the agent's model:

```ts
resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
  // Location plugins populate and filter the catalog asynchronously during layer startup.
  const agent = session.model ? undefined : (yield* agents.select(session.agent)).info?.model
  const available = yield* catalog.model.available()
  const agentModel = agent ? available.find((model) => model.providerID === agent.providerID && model.id === agent.id) : undefined
  const defaultModel = session.model || agentModel ? undefined : yield* catalog.model.default()
  const selected = session.model
    ? available.find((model) => model.providerID === session.model?.providerID && model.id === session.model.id)
    : agentModel ?? (defaultModel && supported(defaultModel) ? defaultModel : available.find(supported))
  if (!selected && session.model)
    return yield* new ModelUnavailableError({
      providerID: session.model.providerID,
      modelID: session.model.id,
    })
  if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
  const provider = yield* catalog.provider.get(selected.providerID)
  const connection = yield* integrations.connection.active(
    provider?.integrationID ?? Integration.ID.make(selected.providerID),
  )
  return yield* resolve(
    session.model ? session : { ...session, model: agentModel ? { providerID: agentModel.providerID, id: agentModel.id, variant: agent?.variant } : undefined },
    selected,
    connection ? yield* integrations.connection.resolve(connection) : undefined,
  )
}),
```

The `resolve` helper (line ~176) reads `session.model?.variant`, so the agent's variant must be carried on the session shape passed to it.

- [ ] **Step 4: Add the dependency**

Change the node export at line 218 to:

```ts
export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [Catalog.node, Integration.node, AgentV2.node],
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/core && bun test test/session-runner-model.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the core suite and typecheck**

Run: `cd packages/core && bun test` — Expected: PASS.
Run: `cd packages/core && bun typecheck` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/session/runner/model.ts packages/core/test/session-runner-model.test.ts
git commit -m "fix(core): use the agent's model when a session has none"
```

---

### Task 3: Add an awaitable plugin-activation signal

The fork's `PluginV2.Interface` has only `add`, `remove` and a per-plugin `wait(id)`. `PluginInternal.boot` and the external-plugin loader both `Effect.forkScoped` their batches, so plugins activate arbitrarily late and nothing can await that. The session runner needs one awaitable "all plugins settled" signal.

**Files:**
- Modify: `packages/core/src/plugin.ts`
- Modify: `packages/core/src/plugin/internal.ts`
- Test: `packages/core/test/plugin.test.ts`

**Interfaces:**
- Consumes: `effect`'s `Latch` (`Latch.makeUnsafe(open?)`, `latch.await`, `latch.openUnsafe`, `latch.closeUnsafe`) — available in `effect@4.0.0-beta.83` and currently unused in the repo.
- Produces:
  - `PluginV2.Interface.awaitActivation: Effect.Effect<void>` — suspends while a plugin batch is in flight; returns immediately when the plugin set is settled.
  - `PluginV2.Interface.hold: () => Effect.Effect<Effect.Effect<void>>` — closes the signal and returns an Effect that re-opens it. Run the returned Effect to release the hold.
  - `export const awaitActivation = Service.use((plugins) => plugins.awaitActivation)` — a module-level convenience export, mirroring upstream's shape.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/plugin.test.ts`:

```ts
test("awaitActivation resolves while the plugin set is settled", async () => {
  // Build the test layer, await plugins.awaitActivation, expect it to resolve.
})

test("awaitActivation suspends while a plugin batch is held", async () => {
  // const release = yield* plugins.hold()
  // start an awaitActivation in a fiber, assert it has not settled
  // yield* release
  // assert the awaitActivation fiber now settles
})

test("a plugin added during a hold is visible to waiters after release", async () => {
  // hold, add a plugin, release, then plugins.wait(id) returns immediately
})
```

Follow the file's existing conventions: `describe("PluginV2", ...)` at line 20, the `it.effect` / `it.live` helpers from `packages/core/test/lib/effect.ts`, and the layer built with `AppNodeBuilder.build(...)` / `LayerNode.group([...])` as the existing tests do.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && bun test test/plugin.test.ts`
Expected: FAIL — `awaitActivation` and `hold` do not exist on the interface.

- [ ] **Step 3: Implement the signal in `packages/core/src/plugin.ts`**

Add to the `Interface` (lines 23–27):

```ts
export interface Interface {
  readonly add: (id: ID, effect: PluginRuntime["effect"]) => Effect.Effect<void>
  readonly remove: (id: ID) => Effect.Effect<void>
  readonly wait: (id: ID) => Effect.Effect<void>
  /** Suspends while a plugin update is in flight; resolves once the plugin set is settled. */
  readonly awaitActivation: Effect.Effect<void>
  /** Keeps readiness pending while an update is prepared. Run the returned Effect to release it. */
  readonly hold: () => Effect.Effect<Effect.Effect<void>>
}
```

In the layer, create the latch and wire it:

```ts
const ready = yield* Latch.makeUnsafe(true)
```

- `add` and `remove` must close the latch for the duration of their work and re-open it when the batch's `State.afterBatch` callback has run. The cleanest place is the existing `State.afterBatch` block inside `add` (line 65): close the latch *before* `State.batch` runs and re-open it inside the `State.afterBatch` callback (both the success and failure branches).
- `remove` (lines 112–125) must close and re-open the latch around its own batch.
- `hold` closes the latch and returns `Effect.sync(() => latch.openUnsafe())`.
- `awaitActivation` is `ready.await`.

Import `Latch` from `effect`.

Add the module-level export next to `use`:

```ts
export const awaitActivation = Service.use((plugins) => plugins.awaitActivation)
```

- [ ] **Step 4: Hold the boot batch in `packages/core/src/plugin/internal.ts`**

In the layer, before the boot batch is forked, take a hold and release it when the fork settles:

```ts
const release = yield* plugin.hold()
yield* State.batch(
  Effect.gen(function* () { /* ...existing adds... */ }),
)
  .pipe(Effect.withSpan("PluginInternal.boot"), Effect.forkScoped({ startImmediately: true }), Effect.onExit(() => release))
```

The hold must be taken **before** the fork, so a runner that awaits `awaitActivation` during boot waits for the whole boot batch.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/core && bun test test/plugin.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the core suite and typecheck**

Run: `cd packages/core && bun test` — Expected: PASS.
Run: `cd packages/core && bun typecheck` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/plugin.ts packages/core/src/plugin/internal.ts packages/core/test/plugin.test.ts
git commit -m "feat(core): add an awaitable plugin-activation signal"
```

---

### Task 4: Make the session runner wait for plugin activation

The runner reads the session's agent (`llm.ts:185`), the model (`llm.ts:209`), skills and references (`llm.ts:171-174`) and materialises tools (`llm.ts:213`) at the start of each turn, and settles tool calls (`llm.ts:271`) whose permission check re-reads the session's agent (`packages/core/src/permission.ts:143`). A plugin reload mid-turn can therefore apply half of a new agent definition. Upstream's equivalent fix awaits plugin activation at three points.

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` (layer deps at lines 98–111; `runTurnAttempt` at 176–367; `toolMaterialization.settle` call at 271; `node` deps at 433–452)
- Test: `packages/core/test/session-runner.test.ts`

**Interfaces:**
- Consumes: `PluginV2.Service.awaitActivation: Effect.Effect<void>` and `PluginV2.Service.hold` from Task 3.
- Produces: no new exported names. The runner's behaviour changes: a turn does not read agent/model/skill state until the plugin set is settled, and a tool call does not run its permission check until the plugin set is settled.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/session-runner.test.ts` a case that:
- builds the runner layer with a `PluginV2` service whose `awaitActivation` suspends on a controllable Deferred,
- starts a turn,
- asserts the model request is **not** made while activation is pending,
- releases activation and asserts the request then goes out.

The suite's `describe("SessionRunnerLLM", ...)` block starts at line 557; follow the existing layer-construction and mock conventions in that file. If the suite builds `PluginV2` through `LayerNode.compile`, replace it with a stub layer that provides the same `Interface` plus a controllable `awaitActivation`; a `Layer.mock`-style partial replacement is preferred over a full fake.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && bun test test/session-runner.test.ts -t "waits for plugin activation"`
Expected: FAIL — the runner issues the request without waiting.

- [ ] **Step 3: Await activation at the start of each turn**

In `packages/core/src/session/runner/llm.ts`:

- Add `import { PluginV2 } from "../../plugin"`.
- In the layer, add `const plugins = yield* PluginV2.Service` with the other service acquisitions (lines 98–111).
- In `runTurnAttempt` (line 176), insert immediately after the function opens and **before** `const agent = yield* agents.select(session.agent)` (line 185):

```ts
// Plugins can reload mid-turn; each step and retry must read the settled agents, models and skills.
yield* plugins.awaitActivation
```

This single insertion also covers the compaction-restore paths, because `ContinueAfterCompaction` and `ContinueAfterOverflowCompaction` (lines 155–169) re-enter `runTurnAttempt` through `runTurn` / `runAfterOverflowCompaction`.

- [ ] **Step 4: Await activation before a tool call's permission check**

Wrap the tool settlement at line 269–290 so the permission check waits for a settled plugin set:

```ts
yield* Effect.uninterruptibleMask((restore) =>
  restore(
    plugins.awaitActivation.pipe(
      Effect.andThen(
        toolMaterialization.settle({
          sessionID: session.id,
          agent: agent.id,
          assistantMessageID,
          call: event,
        }),
      ),
    ),
  ).pipe(
    Effect.flatMap((settlement) => publish(...)),
  ),
).pipe(FiberSet.run(toolFibers))
```

Keep the `Effect.uninterruptibleMask`/`restore` structure so the tool call still cannot be interrupted between the mask and the settlement, and keep the `FiberSet.run(toolFibers)` tail unchanged.

- [ ] **Step 5: Add the dependency**

Add `PluginV2.node` to the `node` deps list (lines 433–452). `PluginV2.node` depends on `EventV2`, `AgentV2`, `AISDK`, `Catalog`, `CommandV2`, `Integration`, `Reference` and `SkillV2` — none of which depend on the session runner — so no cycle is introduced.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/core && bun test test/session-runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the core suite and typecheck**

Run: `cd packages/core && bun test` — Expected: PASS.
Run: `cd packages/core && bun typecheck` — Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/session/runner/llm.ts packages/core/test/session-runner.test.ts
git commit -m "fix(core): wait for plugin activation before each runner step"
```

---

### Task 5: Give each MCP OAuth login its own callback server

`packages/flynncode/src/mcp/oauth-callback.ts` keeps a single module-level HTTP server, a single `currentPort` and a single `currentPath`. `ensureRunning` (lines 105–131) **stops and restarts the server** when the requested port or path differs, so a second MCP server with a different `callbackPort` kills the first server's in-flight login; that login then hangs until its 5-minute timeout. Separately, `packages/flynncode/src/mcp/index.ts:585` clears the module-global `pendingOAuthTransports` map in a *per-instance* finalizer, so one instance's disposal discards another instance's pending OAuth transport.

**Files:**
- Modify: `packages/flynncode/src/mcp/oauth-callback.ts`
- Modify: `packages/flynncode/src/mcp/index.ts`
- Test: `packages/flynncode/test/mcp/oauth-callback.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `McpOAuthCallback.ensureRunning(redirectUri: string): Effect.Effect<void>` — unchanged signature, but it no longer tears down a running server for a different port/path; it starts a second server instead and keeps both until their pending logins drain.
  - `McpOAuthCallback.stop(): Effect.Effect<void>` — stops every server this process started.
  - `McpOAuthCallback.waitForCallback(oauthState: string, mcpName?: string): Effect.Effect<string>` — unchanged signature.

- [ ] **Step 1: Write the failing test**

Add to `packages/flynncode/test/mcp/oauth-callback.test.ts`:

```ts
test("a second callback server does not cancel the first pending login", async () => {
  // ensureRunning for redirect A
  // start a pending login on A (waitForCallback)
  // ensureRunning for redirect B on a different port
  // assert the pending login on A is still pending (not rejected, not resolved)
  // complete A's callback and assert it resolves
})
```

The file already covers `ensureRunning` with a custom port/path (lines 64–67) and the success flow (69–79); follow those patterns, and remember to call `McpOAuthCallback.stop()` in cleanup so the test does not leak listeners.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/flynncode && bun test test/mcp/oauth-callback.test.ts`
Expected: FAIL — the second `ensureRunning` stops the first server and rejects its pending login with "OAuth callback server stopped".

- [ ] **Step 3: Keep one server per redirect target**

In `packages/flynncode/src/mcp/oauth-callback.ts`:

- Replace the single module-level `server` / `currentPort` / `currentPath` state with a `Map<string, { server: Server; port: number; path: string }>` keyed by the redirect target (port + path), so each distinct callback target owns its own listener.
- `ensureRunning` looks the target up in the map; if present it returns, otherwise it creates a server for that target, registers it, and stores it.
- `stopIfIdle` (lines 35–40) closes only the servers that have no pending auth in `pendingAuths` for their target.
- `stop()` (lines 176–188) closes every server in the map and clears it.
- `pendingAuths` (line 19) entries must record which server target they belong to, so `stopIfIdle` can decide per server. Add a `target: string` field to the `PendingAuth` interface (line 12) and set it in `waitForCallback` (line 133).
- `cleanupStateIndex` (lines 26–33) keeps working unchanged.

- [ ] **Step 4: Stop clearing another instance's pending transports**

In `packages/flynncode/src/mcp/index.ts`, the `pendingOAuthTransports` map (line 121) is module-global but cleared in the per-instance finalizer at line 585. Move the map **into** the per-instance `State` record (interface at lines 152–161) so each instance owns its pending transports, and have the finalizer clear only its own.

The map is written at lines 333 and 897 and read at 953; all three sites must read the instance-scoped map instead of the module-level one. The `pendingOAuthTransports` accessor is used inside `connectRemote` (line 333) and `startAuth` / `authenticate` / `finishAuth` (lines 897, 953) — all of which run inside the `InstanceState.make` closure and therefore have `s` in scope. Verify each site compiles against the instance-scoped map.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/flynncode && bun test test/mcp/oauth-callback.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the MCP suite and typecheck**

Run: `cd packages/flynncode && bun test test/mcp` — Expected: PASS.
Run: `cd packages/flynncode && bun typecheck` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/flynncode/src/mcp packages/flynncode/test/mcp/oauth-callback.test.ts
git commit -m "fix(mcp): keep a callback server per redirect target and scope pending transports per instance"
```

---

### Task 6: Keep remote MCP requests open past Bun's fetch idle timeout

Bun's `fetch` aborts requests after its default idle deadline (~5 minutes). The MCP transports in `packages/flynncode/src/mcp/index.ts` are constructed without a `fetch` option (lines 285–289 for `StreamableHTTPClientTransport`, 292–296 for `SSEClientTransport`, 879–882 for the OAuth transport), so the SDK falls back to the global `fetch` and a slow MCP tool call is aborted mid-call even though the MCP execution timeout (the `timeout` in `packages/flynncode/src/mcp/catalog.ts:63` and `packages/flynncode/src/mcp/v2-tools.ts:46`) has not fired. The MCP SDK 1.29.0 accepts `opts.fetch` and propagates it to OAuth discovery and token requests.

**Files:**
- Create: `packages/core/src/util/no-timeout-fetch.ts`
- Modify: `packages/flynncode/src/mcp/index.ts` (lines 285–296, 879–882)
- Test: `packages/flynncode/test/mcp/headers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `packages/core/src/util/no-timeout-fetch.ts` exports `noTimeoutFetch: typeof fetch` — `fetch(request, { ...init, timeout: false } as BunFetchRequestInit)`. The fork has no `packages/util`; `packages/core/src/util/` is the layering-correct home (`packages/flynncode` depends on `@flynncode/core`).

- [ ] **Step 1: Write the failing test**

Add to `packages/flynncode/test/mcp/headers.test.ts` a case that builds a remote MCP config, connects, and asserts that the transport the module created was given a custom `fetch`. The file already inspects the transports created in `connectRemote` (tests at lines 42–62 and 64–83) — follow that pattern.

Assertions to pin:
- The transport's fetch option is a function.
- Calling that fetch with a plain request passes `timeout: false` through to the underlying fetch. Assert this by stubbing `globalThis.fetch` for the duration of the call and inspecting the `init` it receives.

If the SDK does not expose the resolved fetch on the transport instance, assert the weaker but still meaningful property: the `StreamableHTTPClientTransport`/`SSEClientTransport` constructor received an `options.fetch` (observable through a monkey-patched module or by asserting the request is not aborted).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/flynncode && bun test test/mcp/headers.test.ts`
Expected: FAIL — no custom fetch is passed to the transports.

- [ ] **Step 3: Create the shared helper**

Create `packages/core/src/util/no-timeout-fetch.ts`:

```ts
// Bun's fetch aborts requests after its default idle deadline (about five minutes). Clients that
// hold requests open for long-running work (MCP tool calls, session waits, event streams) opt out
// while keeping every other init option, including `signal`.
export const noTimeoutFetch = ((request: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(request, { ...init, timeout: false } as BunFetchRequestInit)) as typeof fetch
```

- [ ] **Step 4: Wire it into the three transport sites**

In `packages/flynncode/src/mcp/index.ts`:

- Import it: `import { noTimeoutFetch } from "@flynncode/core/util/no-timeout-fetch"`.
- Pass `fetch: noTimeoutFetch` in the options of the `StreamableHTTPClientTransport` (lines 285–289) and the `SSEClientTransport` (292–296) inside `connectRemote`.
- Pass `fetch: noTimeoutFetch` in the options of the OAuth `StreamableHTTPClientTransport` (879–882) inside `startAuth`.

Keep the existing `requestInit` (headers) options untouched — the SDK merges the custom fetch with the request init.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/flynncode && bun test test/mcp/headers.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the MCP suite and typecheck**

Run: `cd packages/flynncode && bun test test/mcp` — Expected: PASS.
Run: `cd packages/flynncode && bun typecheck` — Expected: no errors.
Run: `cd packages/core && bun typecheck` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/util/no-timeout-fetch.ts packages/flynncode/src/mcp/index.ts packages/flynncode/test/mcp/headers.test.ts
git commit -m "fix(mcp): keep remote MCP requests open past Bun's fetch idle timeout"
```

---

### Task 7: Guard MCP servers against a duplicate start

`packages/flynncode/src/mcp/index.ts` has no per-server lock and no in-flight-startup record. `add` (674–679), `connect` (681–684) and `finishAuth` (951–975) each call `createAndStore` (660–672) → `create` (393–436), which spawns the transport. Two concurrent calls for the same server name therefore spawn two servers; the second `storeClient` (603–622) closes the first client, but the duplicate process is already alive. The initial reconciliation (529–553) awaits `create` inline, so upstream's exact "forked startup settled while it waited" race cannot occur here — the residual hazard is concurrent explicit `add`/`connect` calls.

**Files:**
- Modify: `packages/flynncode/src/mcp/index.ts`
- Test: `packages/flynncode/test/mcp/lifecycle.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exported names. `MCP.Interface.add`, `connect` and `disconnect` keep their signatures; concurrent calls for one server name now share a single start.

- [ ] **Step 1: Write the failing test**

Add to `packages/flynncode/test/mcp/lifecycle.test.ts`:

```ts
test("concurrent connects for one server start a single session", async () => {
  // count the server's session starts (the fixture at lines 63–66 / 118–125 can count connections)
  // call mcp.connect(name) twice concurrently
  // assert the server saw one connection, and that the status is "connected"
})
```

The suite already has a `disconnect + reconnect` case (308–328) and an `add()` case (330–345) that asserts the replaced session is closed — reuse that fixture pattern to count sessions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/flynncode && bun test test/mcp/lifecycle.test.ts`
Expected: FAIL — two sessions are created.

- [ ] **Step 3: Add the per-server startup guard**

In `packages/flynncode/src/mcp/index.ts`:

- Add `startup: Record<string, Promise<void>>` to the `State` interface (lines 152–161) — a per-server in-flight start.
- In `createAndStore` (660–672), before calling `create`, check `s.startup[name]`:
  - if a start is in flight, await it, then return the existing client instead of creating a second one;
  - otherwise record a promise for this start and clear it when the start settles (success or failure).

The implementation must guarantee the recorded promise is cleared on failure too, so a failed start does not wedge the server name.

- `disconnect` (686–692) must clear any in-flight startup for that name so a later `connect` is not blocked by a stale promise.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/flynncode && bun test test/mcp/lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the MCP suite and typecheck**

Run: `cd packages/flynncode && bun test test/mcp` — Expected: PASS.
Run: `cd packages/flynncode && bun typecheck` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/flynncode/src/mcp/index.ts packages/flynncode/test/mcp/lifecycle.test.ts
git commit -m "fix(mcp): do not start a second session for a server that is already starting"
```

---

### Task 8: Stop RPM build-id links from conflicting with other Electron apps

`rpmbuild` writes `/usr/lib/.build-id` links for every ELF file. The bundled Electron binaries are byte-identical across apps on the same Electron version, so those links collide with other Electron RPMs (Slack, Unity Hub) and rpm/zypper then refuse to install or update. The links only serve debuginfo lookup, so they can be skipped.

**Files:**
- Modify: `packages/desktop/electron-builder.config.ts` (`linuxFpm` helper, lines 17–24; the `rpm` entries at 145, 156, 167)
- Test: `packages/desktop/electron-builder.config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the `rpm.fpm` array for every channel begins with the literal string `--rpm-rpmbuild-define=_build_id_links none`. The `deb.fpm` array must **not** contain it.

- [ ] **Step 1: Write the failing test**

Add to `packages/desktop/electron-builder.config.test.ts`, inside the existing `for (const channel of channels)` loop (lines 10–28):

```ts
// Shared Electron binaries must not ship /usr/lib/.build-id links that collide with other Electron RPMs.
// fpm rejects flags after the first src=dest mapping, so the flag must come first.
expect(config.rpm?.fpm?.[0]).toBe("--rpm-rpmbuild-define=_build_id_links none")
expect(config.deb?.fpm).not.toContain("--rpm-rpmbuild-define=_build_id_links none")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/desktop && bun test electron-builder.config.test.ts`
Expected: FAIL — `config.rpm?.fpm?.[0]` is currently `--before-install=...`.

- [ ] **Step 3: Add the rpm-only fpm flag**

In `packages/desktop/electron-builder.config.ts`, the `linuxFpm` helper (lines 17–24) is shared by `deb` and `rpm`. Add an optional rpm-only flag parameter:

```ts
// rpmbuild adds /usr/lib/.build-id links for every ELF file. The bundled Electron
// binaries are byte-identical across apps on the same Electron version, so those
// links collide with other Electron RPMs and rpm/zypper refuse to install or update.
// They only serve debuginfo lookup, so skip them. fpm only accepts flags before the
// first src=dest mapping, so keep this first.
const rpmNoBuildIdLinksFpm = "--rpm-rpmbuild-define=_build_id_links none"

const linuxFpm = (appId: string, rpm = false) => {
  const stop = path.join(packageDir, "maintainer", "stop-running-instances.sh")
  return [
    `--before-install=${stop}`,
    `--before-remove=${stop}`,
    ...(rpm ? [rpmNoBuildIdLinksFpm] : []),
    metainfoFpm(appId),
  ]
}
```

Then change the three `rpm` entries to `linuxFpm(appId, true)` and leave the three `deb` entries as `linuxFpm(appId)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/desktop && bun test electron-builder.config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd packages/desktop && bun typecheck` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/electron-builder.config.ts packages/desktop/electron-builder.config.test.ts
git commit -m "fix(desktop): stop RPM build-id links conflicting with other Electron apps"
```

---

### Task 9: Fix the theme contrast coefficient and the desktop pointer cursor

**Files:**
- Modify: `packages/ui/src/theme/color.ts` (line 261)
- Modify: `packages/desktop/src/renderer/styles.css` (currently empty)
- Test: `packages/ui/src/theme/color.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `contrastRatio` returns the correct WCAG relative luminance. The desktop renderer applies the default cursor to non-link interactive elements.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/theme/color.test.ts`:

```ts
import { expect, test } from "bun:test"
import { contrastRatio } from "./color"

test("contrast ratio matches the WCAG relative luminance formula", () => {
  // Black on white is the maximum ratio.
  expect(contrastRatio("#000000" as never, "#ffffff" as never)).toBeCloseTo(21, 5)
  // A green that the wrong coefficient materially mis-measures: pure green (#00ff00)
  // against white. With the correct 0.7152 coefficient the ratio is ~1.37; with 0.587 it is ~2.4.
  expect(contrastRatio("#00ff00" as never, "#ffffff" as never)).toBeCloseTo(1.37, 2)
})
```

Check `packages/ui/src/theme/color.ts` for the actual signature of `contrastRatio` (it takes branded `HexColor` values) and use the same construction the file's own callers use rather than a cast.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/ui && bun test src/theme/color.test.ts`
Expected: FAIL — the green coefficient is `0.587`, so the pure-green ratio is wrong.

- [ ] **Step 3: Fix the luminance coefficient**

In `packages/ui/src/theme/color.ts:261`, change:

```ts
return 0.2126 * linear(r) + 0.587 * linear(g) + 0.0722 * linear(b)
```

to:

```ts
return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/ui && bun test src/theme/color.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the desktop cursor rule**

In `packages/desktop/src/renderer/styles.css` (currently a 0-byte file), add upstream's rule, restricted to the selectors that exist in this fork. Verified present in the fork: `.cursor-pointer` (13 call sites in `packages/app/src`), `button[data-component="button-v2"]`, `[data-slot="dialog-close-button"]`, `[data-slot="text-input-v2-icon-button"]`, `[data-slot="segmented-control-v2-item"]`, `[data-component="file-tree-v2"] [data-slot="file-tree-v2-row"]`, `[data-slot="question-option"]`.

```css
/* Desktop controls use the default cursor; the pointer cursor is reserved for links. */
:where(
  .cursor-pointer:not(a):not([role="link"]),
  button[data-component="button-v2"]:not([role="link"]),
  [data-slot="dialog-close-button"],
  [data-slot="text-input-v2-icon-button"],
  [data-slot="segmented-control-v2-item"],
  [data-component="file-tree-v2"] [data-slot="file-tree-v2-row"],
  [data-slot="question-option"]
):not(:disabled) {
  cursor: default !important;
}
```

Before writing the rule, re-run the selector existence check so no dead selector is committed:

```bash
cd /home/yeager1977/GitHub/flynncode && for s in 'data-component="button-v2"' 'data-slot="dialog-close-button"' 'data-slot="text-input-v2-icon-button"' 'data-slot="segmented-control-v2-item"' 'data-component="file-tree-v2"' 'data-slot="file-tree-v2-row"' 'data-slot="question-option"'; do printf "%-46s " "$s"; grep -rl "$s" packages/app/src packages/ui/src packages/session-ui/src | wc -l; done
```

Drop any selector whose count is `0`.

- [ ] **Step 6: Run the UI suite and typecheck**

Run: `cd packages/ui && bun test src` — Expected: PASS.
Run: `cd packages/ui && bun typecheck` — Expected: no errors.
Run: `cd packages/desktop && bun typecheck` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/theme/color.ts packages/ui/src/theme/color.test.ts packages/desktop/src/renderer/styles.css
git commit -m "fix(ui): fix the theme contrast coefficient and reserve the pointer cursor for links"
```

---

## Out of scope (deliberately)

| Upstream work | Why not |
|---|---|
| `packages/core/src/session/**` V2 rewrite, `packages/app/src/session/**` V2 rewrite, `packages/ai` video/speech/media/image/evaluation modules | The fork has its own V2 session core, app shell and `packages/llm`. Upstream's parallel implementation would replace working fork code. |
| MCP over client websockets, Console usage limits, background compaction summaries | Substantial features, not "changes that make sense" in a sync pass. Each needs its own design. |
| `packages/ui/src/theme/themes/*.json` palette churn (catppuccin, kanagawa) | Aesthetic, and the fork owns its palette (`oc-2.json` already diverges). The functional luminance fix in Task 9 is the part that matters. |
| Upstream's refactor commits (735 of them in the window) | The fork's code is not upstream's code; the refactors do not apply. |
| `packages/console`, `packages/stats`, `packages/web`, `services/www`, nix, CI, release workflows | Not part of the fork's shipped product surface. |

## Self-review

- **Spec coverage:** every gap found in the review maps to a task — provider error classification → Task 1; agent-model fallback → Task 2; plugin activation ordering → Tasks 3–4; MCP OAuth stray callback / shared callback server / duplicate start / idle timeout → Tasks 5–7; RPM build-id → Task 8; theme contrast + pointer cursor → Task 9.
- **Step scan:** every step names one file, one signature and the exact assertions; no step says "handle edge cases" or "write tests for the above".
- **Type consistency:** `awaitActivation` / `hold` are defined in Task 3 and consumed in Task 4; `ProviderFailure` and `classifyProviderFailure` are defined in Task 1 and consumed in the same task's executor change; `noTimeoutFetch` is created and consumed in Task 6.
- **Review focus:** all eight listed failure modes are pinned by a named test in the task that owns the code.
- **Proportion:** nine tasks, each a focused change with its own test cycle. No task is a transcript of the implementation.
