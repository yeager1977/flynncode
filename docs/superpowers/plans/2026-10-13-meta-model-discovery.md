# Meta Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Muse Wonder Full locally and discover connected Meta chat models automatically.

**Architecture:** Reuse the existing bounded `/models` transport after provider authentication/options resolve. Add a Meta-specific model mapper that preserves existing entries and derives new Muse model metadata from the nearest catalog family. Use existing provider/catalog invalidation and model-router catalog consumption.

**Tech Stack:** Bun, TypeScript, Effect v4, OpenAI Responses SDK, JSONC configuration.

## Global Constraints

- Use the same effective credentials and endpoint for discovery and inference.
- Preserve model metadata, configured aliases, overrides, reasoning variants, and filters.
- Exclude standalone image/audio/segmentation endpoints from chat selection.
- Preserve the existing model list on discovery failure or empty results.
- Use the existing refresh lifecycle; no new poller or authentication flow.
- Extend existing contributor confirmation to newly discovered Muse contributor models.
- Run tests and `bun typecheck` from package directories.
- Preserve unrelated working-tree changes; commits are not requested.

---

### Task 1: Discover connected Meta models

**Files:**
- Create: `packages/flynncode/src/provider/meta.ts`
- Modify: `packages/flynncode/src/provider/provider.ts`
- Modify: `packages/flynncode/test/provider/provider.test.ts`

**Interfaces:**
- Consumes: `ProviderDiscover.discover(baseURL: string, apiKey: string | undefined): Promise<Discovered[]>`, resolved `Provider.Info`, and `ProviderTransform.variants(model)`.
- Produces: a merged `Record<string, Provider.Model>` on the connected Meta provider, consumed by existing filtering, model selection, and router catalog loading.

- [ ] Add an authenticated local `/meta/v1/models` route returning `muse-wonder-full-1.0`, a future Spark model, contributor models, and `muse-image-1.0`/`muse-voice-transcribe-1.0`/`sam-3.1`.
- [ ] Add integration tests whose key expectations are:

```ts
expect(provider.models["muse-wonder-full-1.0"].api.npm).toBe("@ai-sdk/openai")
expect(provider.models["muse-wonder-full-1.0"].name).toBe("Muse Wonder Full")
expect(provider.models["muse-wonder-full-1.0"].capabilities.reasoning).toBe(true)
expect(provider.models["muse-image-1.0"]).toBeUndefined()
expect(provider.models["muse-voice-transcribe-1.0"]).toBeUndefined()
expect(provider.models["sam-3.1"]).toBeUndefined()
expect(provider.models["custom-wonder"].name).toBe("My Wonder")
expect(collectCandidates({}, options, providers).map((item) => item.key)).toContain("meta/muse-wonder-full-1.0")
```

- [ ] Run `bun test test/provider/provider.test.ts --test-name-pattern 'Meta discovery' --timeout 30000` from `packages/flynncode`; confirm discovery assertions fail before implementation.
- [ ] Implement a synchronous Meta mapper below its self-export boundary. Preserve exact existing entries, recognize `muse-*` chat IDs, choose a Wonder/Spark family template (prefer matching contributor/non-contributor entries), replace identity/name/API URL, apply supplied endpoint limits, generate reasoning variants, and merge new entries.
- [ ] Invoke discovery after config options/authentication merge and before model filtering. The integration follows:

```ts
const meta = providers[ProviderV2.ID.make("meta")]
// Only an allowed, connected Meta provider participates.
// Resolve options.baseURL first, then the catalog/model API endpoint.
// Resolve the key with effectiveApiKey using meta.source/key/options.apiKey.
// Wrap discovery with Effect.tryPromise and recover with the unchanged list.
```

- [ ] Test saved-auth/config/environment key precedence, base URL overrides, provider disablement, whitelist/blacklist, metadata preservation, endpoint limit overrides, malformed/empty/HTTP-error fallback, and refresh-driven rediscovery using the existing real HTTP server/instance fixture.
- [ ] Run the provider integration tests and model-router candidate/family tests.

### Task 2: Preserve contributor confirmation

**Files:**
- Modify: `packages/app/src/utils/contributor-models.ts`
- Modify: `packages/app/src/utils/contributor-models.test.ts`

**Interfaces:**
- Consumes: `(providerID: string, modelID: string)` from the existing session/model-picker confirmation gate.
- Produces: `isContributorModel(providerID, modelID): boolean`, retaining existing ack behavior.

- [ ] Add cases for Wonder, Full Wonder, and future Spark contributor IDs. Regular models, other providers, and `-contributor-free` remain false.
- [ ] Run `bun test src/utils/contributor-models.test.ts` from `packages/app` and confirm the new contributor cases fail.
- [ ] Replace the static Spark set with `providerID === "meta" && /^muse-.+-contributor$/.test(modelID)`.
- [ ] Run contributor utility and existing session confirmation-gate tests.

### Task 3: Add the local Full entry and verify

**Files:**
- Modify: the active global JSONC configuration (`~/.config/flynncode/opencode.jsonc` after import, otherwise the verified active legacy config).

**Interfaces:**
- Consumes: current configuration plus the cached Wonder model's fallback metadata.
- Produces: `provider.meta.models["muse-wonder-full-1.0"]`, selectable without rebuilding discovery code.

- [ ] Determine the active configuration directory from the current Flynncode loader. Inspect only necessary configuration fields and never print credentials.
- [ ] Add the following model under the existing `provider` object, preserving comments and existing entries:

```json
"meta": {
  "models": {
    "muse-wonder-full-1.0": {
      "name": "Muse Wonder Full",
      "provider": { "npm": "@ai-sdk/openai", "api": "https://api.meta.ai/v1" },
      "family": "muse",
      "reasoning": true,
      "attachment": true,
      "tool_call": true,
      "temperature": true,
      "modalities": {
        "input": ["text", "image", "video", "pdf", "audio"],
        "output": ["text"]
      },
      "limit": { "context": 1048576, "output": 131072 }
    }
  }
}
```

- [ ] Run `bun typecheck` separately in `packages/flynncode` and `packages/app`.
- [ ] Run the focused provider, router, and contributor tests. Inspect the final diff for unrelated changes.
- [ ] Resolve models through the actual Flynncode provider loader and confirm `meta/muse-wonder-full-1.0`, its Responses SDK, and reasoning variants. Do not send a billable generation prompt.
- [ ] Report tested results, any existing check failures, the required user restart for local configuration, and the rebuild needed for source functionality.
