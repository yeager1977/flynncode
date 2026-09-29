# Claude 5 Default-Model Priority — Design

Date: 2026-09-29
Status: Approved (Approach A); amended 2026-09-29 after dry-run verification of
`sort()` ranking semantics

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

## Ranking mechanics (load-bearing; drives the array order below)

The `sort()` implementation (verified at `provider.ts:2208-2215`) ranks by
`priority.findIndex((filter) => model.id.includes(filter))` under a
**descending** modifier. Concretely: the **last matching entry in `priority`
wins**; models matching no entry rank below all ranked ones. Tiebreaks, in
order: IDs containing `latest` sort first, then lexicographically descending
by ID.

Under descending semantics, to make Sonnet the default wherever it exists while
letting Opus act as the Sonnet-less fallback, `claude-sonnet` must sit at a
**later** index than `claude-opus-5` — Sonnet's effective rank (4) must exceed
Opus's (1).

## Change (Approach A — family-prefix matching)

In `packages/opencode/src/provider/provider.ts`, replace the `priority` array:

```ts
// Before
const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]

// After
const priority = ["gpt-5", "claude-opus-5", "big-pickle", "gemini-3-pro", "claude-sonnet"]
```

Two edits, one line:

1. `"claude-sonnet-4"` → `"claude-sonnet"`, repositioned to the **last** index —
   the substring now matches every Sonnet generation, and under descending
   rank semantics its last-match position makes Sonnet the top-ranked family;
   the existing id-descending tiebreak then picks the newest Sonnet
   (currently `claude-sonnet-5-5`). Decay-proof: Claude 6.x sonnets keep
   matching.
2. Insert `"claude-opus-5"` at index 1 (after `gpt-5`, before `big-pickle`) —
   a fallback so a Sonnet-less Anthropic catalog still defaults to a 5.x Opus
   rather than an unranked legacy pick.

### Verified consequence table (dry-run against real `sort()` semantics)

| Catalog contains | Default resolves to | Why |
| --- | --- | --- |
| `claude-sonnet-5-5` + `claude-sonnet-4-6` + `claude-opus-5` | `claude-sonnet-5-5` | Sonnet rank 4 > Opus rank 1; id-desc tiebreak picks 5-5 over 4-6 |
| `claude-opus-5` + `claude-fable-5-1` only (Sonnet-less) | `claude-opus-5` | Opus rank 1 beats all unranked |
| Legacy-only: `claude-sonnet-4-5-20250929` + `claude-opus-5` | `claude-sonnet-4-5-20250929` | Dated 4.x IDs also match `claude-sonnet` (rank 4) — Sonnet-first family preference outweighs generation recency. Accepted. |
| `claude-sonnet-5-5` + `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5` | Same rank; id-desc tiebreak prefers unprefixed 5.x over dated 4.x |
| OpenAI only: `gpt-5` + others | `gpt-5` | `gpt-5` entry untouched; no OpenAI ID contains any Claude substring |

`sort()` runs **per provider** (`provider.ts:1200`, `provider.ts:2158`), so a
model ID only ever competes within its own provider's catalog — no
OpenAI/Gemini ID contains `claude-opus-5` or `claude-sonnet`, and
Anthropic-side ranking is unaffected by the OpenAI entries' relative order.

Known cross-provider exception: `packages/opencode/src/acp/service.ts:811-814`
sorts a flat list across **all** providers to pick ACP's "best" model. With
`claude-sonnet` ranked above `gpt-5`/`big-pickle` there, an aggregate catalog
listing both flips its top pick from a GPT model to the newest Claude Sonnet.
That flip is intentional under this design (newest-generation preference) and
is called out in Risks.

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
| `packages/opencode/src/provider/provider.ts` (line ~2178; `sort` at ~2208) | Update `priority` array |
| `packages/opencode/test/provider/provider.test.ts` (new tests after the existing `provider.sort` test at ~line 990) | Ranking assertions (see Testing) |

No protocol/API changes, no SDK regeneration, no schema changes, no migration.

## Testing

1. New pure unit tests next to the existing `provider.sort` test in
   `packages/opencode/test/provider/provider.test.ts`, asserting the verified
   descending-last-match-wins semantics:
   - both families present → `claude-sonnet-5-5` ranks first, above
     `claude-sonnet-4-6`, above `claude-opus-5`.
   - Sonnet-less catalog → `claude-opus-5` ranks above unranked entries
     (e.g. `claude-fable-5-1`).
   - legacy-4.x + Opus → dated `claude-sonnet-4-5-20250929` ranks above
     `claude-opus-5` (Sonnet-first family preference — intentional).
2. Existing `provider.sort` test ("prioritizes preferred models") must pass
   unchanged: under both the old and new arrays, `claude-sonnet-4-latest`
   still ranks first and `gpt-5-turbo` above the unranked entries.
3. Existing provider/transform tests must pass unchanged — the change must not
   alter OpenAI, Gemini, or Bedrock/Vertex transform behavior.
4. `bun typecheck` from `packages/opencode` (never `tsc` directly).
5. Spot-check: `provider-family.ts` tier resolution still yields
   `claude-opus-5-5` (flagship) and `claude-sonnet-5` (balanced) for an
   Anthropic-family selection — untouched by this change, covered by existing
   router tests.

## Risks

- Intentional behavior change: fresh Anthropic users' default flips from
  Sonnet 4.6 to Sonnet 5.5. Users who pinned `model` in config are unaffected
  (`cfg.model` short-circuits the default path).
- Dated 4.x snapshot IDs match the `claude-sonnet` family substring and
  outrank Opus under the new order (Sonnet-first preference). Accepted; the
  id-descending tiebreak still prefers unprefixed 5.x IDs over dated 4.x ones
  when both exist.
- ACP's cross-provider "best" pick (`acp/service.ts:811-814`) may flip from a
  GPT model to the newest Claude Sonnet for aggregate catalogs. Intentional
  under "smart defaults point at the new generation" (user-approved).
- `gpt-5`, `big-pickle`, `gemini-3-pro` entries are untouched, so within-provider
  ordering among non-Claude models is unchanged.