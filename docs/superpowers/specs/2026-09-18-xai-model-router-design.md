# xAI / Grok in the Model Router - Design

Date: 2026-09-18
Status: Implemented

## Problem

The xAI provider is connected (`xai` is in `auth.json`; see the xAI provider
verification) and its Grok models resolve from models.dev, but the Model Router
cannot select any of them.

Three independent gates exclude xAI today:

1. **Provider allowlist.** `model_router.providers` is
   `["ollama-cloud", "anthropic", "openai"]`, and `candidates.ts` keeps only
   providers in that list (`selected()`), so every xAI model is dropped before
   scoring.
2. **Unscored gate.** `allowUnscored: false`, and `rank.ts` excludes any
   candidate with no scorecard entry (`excluded: "unscored"`). No xAI model has
   an entry.
3. **Task tags.** A model whose `tags` do not include the active task is
   excluded for that task; a model with no tags is eligible everywhere.

Adding xAI to the provider list alone fixes nothing: with `allowUnscored: false`
every Grok model is still excluded.

A fourth, latent hazard: nothing filters on tool-call support. Scoring a
non-agentic model makes it routable. `grok-imagine-image`,
`grok-imagine-video`, and `grok-imagine-video-1.5` report `tool_call: false`
and produce no output tokens, so they must never be scored.

## Goal

Make the agentic Grok models first-class routing candidates, with scores
grounded in their real cost/context/reasoning metadata, and ship the scores as
built-in defaults so every user gets them without hand-editing config.

## Scope

In scope:

- A bundled default scorecard for xAI, merged under user config.
- Broad task tags for the agentic Grok models, per the table below.
- Excluding the non-agentic `grok-imagine-*` models from routing.
- Adding `xai` to the effective provider set when the user has connected xAI.
- Applying the same to the local config so routing works immediately.
- Tests for the defaults and the merge precedence.

Out of scope:

- Auto-scoring arbitrary providers from models.dev pricing (a larger,
  provider-agnostic change).
- Changing the scoring dimensions or task weights.
- Tool-call filtering as a general rule (handled here by simply not scoring
  the non-agentic models).

## The Model Set

Metadata from models.dev, used to ground every score:

| Model | ctx | output | reasoning | tool_call | input/output $/M (base) |
|---|---|---|---|---|---|
| `grok-4.6` | 500k | 500k | yes | yes | 2 / 6 |
| `grok-4.5` | 500k | 500k | yes | yes | 2 / 6 |
| `grok-4.20-0309-reasoning` | 1M | 30k | yes | yes | 1.25 / 2.5 |
| `grok-4.20-0309-non-reasoning` | 1M | 30k | no | yes | 1.25 / 2.5 |
| `grok-4.3` | 1M | 30k | yes | yes | 1.25 / 2.5 |
| `grok-build-0.1` | 256k | 256k | yes | yes | 1 / 2 |
| `grok-4.20-multi-agent-0309` | 1M | 30k | yes | **no** | 1.25 / 2.5 |
| `grok-imagine-image` | 16k | 0 | no | **no** | — |
| `grok-imagine-video` | 1k | 0 | no | **no** | — |
| `grok-imagine-video-1.5` | 1k | 0 | no | **no** | — |

## Bundled Default Scorecard

Calibrated against the user's existing 1-10 entries, where `claude-opus-5` is
capability 10 / price 8 and `gpt-5.6-luna` is capability 7 / price 1. Price is
inverted in scoring (10 - price), so a cheaper model gets a higher price score.

| Key | capability | price | speed | tags |
|---|---|---|---|---|
| `xai/grok-4.6` | 9 | 7 | 4 | coding, planning, architecture |
| `xai/grok-4.5` | 9 | 7 | 4 | coding, planning, review |
| `xai/grok-4.20-0309-reasoning` | 8 | 4 | 5 | coding, long-context |
| `xai/grok-4.20-0309-non-reasoning` | 7 | 3 | 7 | coding, lookup |
| `xai/grok-4.3` | 8 | 4 | 5 | coding, long-context |
| `xai/grok-build-0.1` | 7 | 3 | 6 | coding |

Rationale for the two deliberate omissions:

- `grok-4.20-multi-agent-0309` is **left unscored** because it advertises
  `tool_call: false`.
- The `grok-imagine-*` models are **left unscored** for the same reason, and
  additionally listed in `excludeModels`.

**Correction found in self-review:** `allowUnscored` defaults to `true`
(`scorecard.ts:72`). The user's config sets it to `false`, but a default user
does not. Leaving a model unscored therefore only excludes it when
`allowUnscored: false`. For `allowUnscored: true` an unscored model scores a
neutral 5/5/5 and becomes eligible. The `excludeModels` entry is what makes the
exclusion hold in both cases, so the `grok-imagine-*` exclusions are load-bearing
rather than belt-and-braces. `grok-4.20-multi-agent-0309` should be added to
`excludeModels` as well, for the same reason.

This satisfies the broad-tags decision: Grok competes for coding, planning,
review, architecture, lookup, and long-context, while the quality-first weights
keep premium tasks (architecture, planning) with the strongest models unless
Grok genuinely outscores them.

## Merge Semantics

Bundled defaults are the **base**; user config is the **override**:

- A user entry for the same key replaces the bundled entry wholesale. Per-field
  merging is deliberately avoided: a user who sets
  `xai/grok-4.6: { capability: 10 }` expects to be in control, not to inherit
  three bundled fields they cannot see.
- A user entry for a key not in the defaults is added as-is.
- Defaults never populate `taskModels`. Pins remain purely a user decision.

**Correction found in self-review:** `excludeModels` is parsed as a replacement
(`scorecard.ts:147-154`), not a union. A user list today would discard bundled
exclusions. The merge must therefore union them explicitly, which is a real
change to how the default and config combine:

- Bundled exclusions are always present, because they encode agentic
  correctness (a model that cannot call tools must not be routable).
- User exclusions are added on top.
- A user cannot remove a bundled exclusion. If that ever becomes necessary, it
  should be an explicit opt-out rather than an accidental side effect of
  writing a list.

This means `excludeModels` is the one field whose merge differs from the
replace rule, and the spec calls that out rather than leaving it implicit.

## Provider Selection

Bundled scores are useless if xAI is not an eligible provider. Rather than
silently rewriting the user's explicit `providers` list, the rule is:

- If `model_router.providers` is non-empty, it stays authoritative. The user
  must add `xai` to it. The local config update below does this for the current
  machine.
- If `model_router.providers` is empty, the default is providers whose id
  starts with `ollama`. This is existing behaviour and is unchanged.

The bundled defaults therefore do not change provider selection by themselves.
This is intentional: an explicit allowlist that silently grew would make
routing unpredictable.

## Activation Scope

**Correction found in self-review:** the plugin stays inert when there is no
`model_router` key: `resolveOptions` returns `raw === undefined` and the config
hook returns early (`index.ts:95-103`). `parseOptions` is never called, so
bundled defaults cannot reach a user who has not configured the router at all.

Therefore the bundled defaults mean: **every user who has an active
`model_router` config gets Grok scored automatically.** They do not make the
router activate for users who have no `model_router` key, and this design does
not change that. Claiming otherwise would require making an unconfigured plugin
active, which contradicts the deliberate "silently inert" behaviour and is out
of scope.

## Local Config Update

Apply the same result the Settings UI would save, so routing works immediately
on this machine:

- Add `xai` to `model_router.providers`.
- Add the six scored entries above to `model_router.models`.
- Add the three `grok-imagine-*` keys to `model_router.excludeModels`.

The file is JSONC with comments; edits must preserve formatting and comments
and must be validated by the repo's own jsonc parser after writing.

## Testing

- A unit test that the bundled defaults parse cleanly through `parseOptions`
  and produce exactly the six scored keys with the expected scores and tags.
- A unit test that a user entry overrides a bundled entry wholesale, and that a
  new user key is added.
- A unit test that `excludeModels` is unioned and that bundled exclusions
  survive a user list.
- A unit test that the `grok-imagine-*` keys and
  `grok-4.20-multi-agent-0309` are not routable with `allowUnscored: false`.
- A candidate-level test that adding `xai` to `providers` makes the six models
  appear in `collectCandidates`, and that without it they do not.
- A config test that the local config file is valid JSONC after the edit.

## Verification

- `rank_models` on the coding task lists Grok entries after the change, with
  the bundled scores visible.
- A live check that `provider.list` returns `xai` with models and that the
  router's candidate set includes the six keys.
- The local config parses with zero errors and still contains its comments.

## Risks

- **Score inflation by bundle.** Shipping defaults means every user gets Grok
  scores they did not choose. Mitigated by making user entries win wholesale
  and by not touching task pins.
- **Model deprecation.** xAI model ids include dated variants
  (`grok-4.20-0309-*`). A bundled entry for a retired id is inert but stale.
  Accepted; the keys are cheap to prune later.
- **`tool_call: false` is a claim, not a guarantee.** The design relies on
  models.dev metadata. If a multi-agent model later gains tool support, it
  simply stays unscored until a human scores it.
