# Claude 5 Default-Model Priority — Design

Date: 2026-09-29
Status: Approved (Approach A)

## Problem

Flynncode resolves the default model for a provider via a hardcoded priority list
of model-ID substrings in `packages/opencode/src/provider/provider.ts`:

```ts
const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
```

`sort()` ranks models by whether their ID contains one of these substrings. The
`claude-sonnet-4` entry matches only Sonnet 4.x IDs (`claude-sonnet-4-5`,
`claude-sonnet-4-6`); every Claude 5.x model (`claude-sonnet-5`,
`claude-sonnet-5-5`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5-1`)
matches nothing and ranks last. A user connected only through the Anthropic
provider therefore gets **claude-sonnet-4-6** — a two-generation-old model — as
their default instead of a current 5.x model.

This is upstream lag, not a fork regression: upstream `dev`
(anomalyco/opencode, `provider.ts:2069` on `dev`) ships the identical list.
Flynncode leads here.

Everything else Claude-5.x-related is already correct in this fork and verified
against the live models.dev catalog (2026-09-29):

- Model catalog (`packages/core/src/models-dev.ts`): auto-syncs from
  `https://models.opencode.ai/api.json`; already lists `claude-fable-5`,
  `claude-fable-5-1`, `claude-opus-5`, `claude-opus-5-5`, `claude-sonnet-5`,
  `claude-sonnet-5-5`, `claude-haiku-4-5` with correct pricing, 1M context, and
  effort options `low/medium/high/xhigh/max`. No repo-side model list exists to
  edit.
- Request transforms (`packages/opencode/src/provider/transform.ts`): adaptive
  thinking gate (`major > 4`), full effort ladder, thinking binding for 5.1+,
  Mythos 5.1 exception, Opus 5.5+/Fable 5.1+ forced-tool-choice rejection — all
  present and correct. No changes.
- Ollama model router tiers
  (`packages/opencode/src/plugin/ollama-model-router/provider-family.ts`):
  `claude-opus-5-5` / `claude-sonnet-5` / `claude-fable-5-1` are real live
  catalog IDs. No changes.
- Small-model selection (`provider.ts`): matches on `model.family`
  (`claude-haiku`), which already resolves the newest Haiku. No changes.
- `packages/app/src/components/settings-v2/omo-catalog.ts`: faithful snapshot
  of the pinned `oh-my-openagent` package; all Claude IDs it references still
  exist in the catalog. Leave as-is — hand-editing drifts it from its source.

## Change (Approach A — family-prefix matching)

In `packages/opencode/src/provider/provider.ts`, replace the Claude entry in
the `priority` array:

```ts
// Before
const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]

// After
const priority = ["gpt-5", "claude-sonnet", "big-pickle", "gemini-3-pro", "claude-opus-5"]
```

Two edits, one line:

1. `"claude-sonnet-4"` → `"claude-sonnet"` — the substring now matches every
   Sonnet generation; the existing id-descending tiebreak picks the newest
   (currently `claude-sonnet-5-5`). Decay-proof: Claude 6.x sonnets keep
   matching.
2. Append `"claude-opus-5"` as the **last** entry — a fallback so an Anthropic
   catalog without any Sonnet still defaults to a 5.x Opus rather than an
   unranked legacy pick.

The `sort()` implementation (verified at `provider.ts:2208-2215`) ranks by
`priority.findIndex((filter) => model.id.includes(filter))` under a
**descending** modifier — so the **last** matching entry in `priority` wins,
and models matching no entry sort below all ranked ones. Consequences of the
array above, all intentional:

- `claude-opus-5` (last) outranks `gpt-5` for Anthropic models. Required for
  the fallback to function. Safe globally: `sort()` runs per provider, so a
  model ID only ever competes within its own provider's catalog, and no
  OpenAI/Gemini model ID contains the substring `claude-opus-5`.
- Among ranked entries, a Sonnet 5.x ID's last match is `claude-sonnet`
  (index 1) while an Opus 5.x ID's last match is `claude-opus-5` (index 4):
  Sonnet remains the default wherever both exist. Neither substring matches
  the other's family, so order between the two entries cannot collide.
- The id-descending tiebreak correctly prefers unprefixed 5.x IDs
  (`claude-sonnet-5-5`) over dated 4.x snapshot IDs
  (`claude-sonnet-4-5-20250929`), which the `claude-sonnet` entry also
  matches.

**Ranking mechanics (load-bearing, verified at `provider.ts:2208-2215`):**

Deliberately excluded: `claude-fable` from the priority list. Fable is the
premium flagship at $10/$50 per MTok; a default-model pick should not silently
select the most expensive tier when Sonnet exists. The Ollama model router
already exposes it deliberately at its `balanced-writing` tier.

### Why not the alternatives

- **B — bump the literal** (`claude-sonnet-5` alongside `claude-sonnet-4`):
  zero-risk, but re-decays at the next generation and leaves the 4.x entry
  matching 4.x models that rank ahead of 5.x (harmful if a 4.x model remains
  in-catalog).
- **C — release-date-based sorting**: most robust, but changes default
  selection semantics for every provider, not just Anthropic. Out of scope for
  this task; revisit upstream.

## Affected code

| File | Change |
| --- | --- |
| `packages/opencode/src/provider/provider.ts` (line ~2178, `sort` at ~2208) | Update `priority` array |
| `packages/opencode/test/provider/provider.test.ts` | Add default-model resolution test (see Testing) |

No protocol/API changes, no SDK regeneration, no schema changes, no migration.

## Testing

1. New unit test in `packages/opencode/test/provider/provider.test.ts` (or the
   closest existing suite for `sort`/default-model selection), asserting on
   the real `sort()` ranking semantics (last matching priority entry wins):
   - given a fixture provider containing `claude-sonnet-4-6`,
     `claude-sonnet-5-5`, and `claude-opus-5`: `sort()` must rank
     `claude-sonnet-5-5` first (beats 4.6 via `claude-sonnet`, beats Opus via
     earlier effective rank), and the default-model path must resolve to it.
   - given a Sonnet-less Anthropic fixture (`claude-opus-5` plus legacy
     `claude-sonnet-4-5` and an unranked model): `claude-opus-5` must rank
     above both.
2. Existing provider/transform tests must pass unchanged — the change must not
   alter OpenAI, Gemini, or Bedrock/Vertex default behavior.
3. `bun typecheck` from `packages/opencode` (never `tsc` directly).
4. Spot-check: `provider-family.ts` tier resolution still yields
   `claude-opus-5-5` (flagship) and `claude-sonnet-5` (balanced) for an
   Anthropic-family selection — untouched by this change, verified by existing
   router tests if present.

## Risks

- Behavior change is intentional: new Anthropic users' default flips from
  Sonnet 4.6 to Sonnet 5.5. Users who pinned `model` in config are unaffected
  (`cfg.model` short-circuits the default path).
- The substring `claude-sonnet` also matches dated snapshot IDs
  (`claude-sonnet-4-5-20250929`); the id-descending tiebreak handles that
  correctly (unprefixed 5.x IDs sort above dated 4.x ones).
- OpenAI's `gpt-5` entry and Gemini/`big-pickle` entries are untouched, so
  non-Anthropic default ordering is unchanged except where a Claude model
  previously ranked unranked-last; ordering among non-Claude families is
  unchanged.