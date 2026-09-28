# Model Family Defaults and Provider Override Design

**Status:** Draft for review
**Date:** 2026-09-28
**Area:** `packages/core/src/v1/config`, `packages/opencode/src/plugin/ollama-model-router`, `packages/app/src/components/settings-v2`

## Goal

Two related changes to model selection in Flynncode:

1. **GPT-6 baseline.** Any model-class chain that does not contain a `deepseek` or
   `glm` rung leads with the GPT-6 family. Chains that explicitly depend on
   deepseek or glm are left untouched.
2. **Provider-family override.** A single toggle selects Ollama, OpenAI, or
   Anthropic; every model class then resolves to that provider's appropriate
   model, picked dynamically from the live catalog.

## Background and Scope Correction

Flynncode does not import the `oh-my-openagent` (OMO) package. There are **two
distinct chain sources**, and they must not be confused:

- **Runtime defaults:** the installed OMO package, configured through
  `oh-my-openagent.jsonc`. This file is written by
  `packages/opencode/src/config/omo-files.ts` and holds `agents`, `categories`,
  and `disabled_providers`. These values actually drive OMO model selection at
  runtime.
- **UI snapshot:** `packages/app/src/components/settings-v2/omo-catalog.ts`. It
  is imported only by `omo-settings.tsx` and `omo-config-payload.ts` for labels
  and payload construction. Editing it does **not** change runtime selection; it
  only changes what the Settings UI displays as the "auto" chains.

The snapshot currently reflects `gpt-5.6-*` models, not `gpt-6-*`. The GPT-6
family exists in the OMO repository but is not what this snapshot was copied
from.

**Consequence:** the GPT-6 baseline default change is authored where the runtime
chains live (the OMO package / `oh-my-openagent.jsonc`), not by editing
`omo-catalog.ts`. The Flynncode-repo work is the provider-family override plus
keeping the UI snapshot in sync. This scope split is an open question below.

Flynncode's own model taxonomy is the router task classes in
`packages/opencode/src/plugin/ollama-model-router/types.ts`:

```
coding | planning | review | architecture | lookup | writing | long-context
```

Routing already resolves a concrete model per class at runtime from the live
catalog: `index.ts` loads `input.client.provider.list()` and caches it as
`CatalogLike`; `rank.ts` scores candidates per task; `assign.ts` returns the
winner. Catalog models expose a `family` field, which is the discriminator the
override uses.

The `model_router` config key is already an opaque record validated by
`scorecard.ts parseOptions`, and `packages/opencode/src/config/config.ts`
treats it as a whole-subtree replacement on patch.

## Non-Goals

- No change to scorecard `DEFAULT_MODELS` values (the bundled Grok ranking
  entries) unless separately requested.
- No change to the sentinel `model-router/auto` provider or the `chat.message`
  rewrite path.
- No change to how explicit per-agent or per-task pins are stored.

## Config Surface

A new top-level `opencode.jsonc` key, declared in
`packages/core/src/v1/config/config.ts` next to `model` and `small_model`:

```
model_family: "auto" | "ollama" | "openai" | "anthropic"   // default "auto"
```

`"auto"` preserves current behavior exactly. The value flows through the
existing config loader; the router reads it during its `config` hook. The
Settings UI writes it through the same `serverSync().updateConfig(...)` path
already used by `model-router.tsx`.

Rationale for a top-level key over a `model_router` sub-key: the override is a
global model-selection concern that also applies when the router plugin is
disabled, and it stays legible in the config file.

## Class to Model Mapping

Each task class maps to a capability tier. Each family maps a tier to a
concrete model. Resolution is dynamic: when the named model is absent from the
live catalog, the override falls through the family order Ollama -> OpenAI ->
Anthropic, then falls back to the family's latest model matching the tier.

| Task class | Tier | OpenAI | Anthropic |
| --- | --- | --- | --- |
| `architecture`, `review` | flagship reasoning | `gpt-6-astra` | `claude-opus-5-5` |
| `coding` | balanced | `gpt-6-sol` | `claude-sonnet-5` |
| `planning`, `writing` | balanced writing | `gpt-6-sol` | `claude-fable-5-1` |
| `lookup`, `long-context` | fast / long-context | `gpt-6-sol-fast` | `claude-sonnet-5` |
| quick fallback | fast | `gpt-6-luna-fast` | `claude-haiku-4-5` |

Ollama is deliberately not tier-mapped. The family constrains candidates to
Ollama providers and the existing `rank.ts` scoring picks the best model per
class, which is already how local class selection works.

## Resolution and Precedence

Precedence, highest first:

```
explicit pins (taskModels, agent model, session selection)
  > model_family override
    > existing rank and class defaults
```

The override is applied when the router builds its candidate set, not by
rewriting config. The sentinel provider and message rewrite are unchanged.
When the selected family has no credential or no catalog entry for a class,
the fallback order Ollama -> OpenAI -> Anthropic applies; when all three are
unavailable, resolution degrades to current behavior.

## GPT-6 Baseline Defaults

The chains that require the GPT-6 baseline are the runtime OMO chains. The rule,
applied to each chain:

- **Skip** any chain containing a `deepseek` or `glm` rung (for example `quick`
  has `deepseek-v4-flash`; `unspecified-low` has `deepseek-v4-pro`;
  `unspecified-high`, `oracle`, and `momus` have `glm-5.2`).
- **Re-point** every other chain's lead rung to the appropriate GPT-6 model.

On the current snapshot this means:

- Categories: `visual-engineering`, `artistry`, `writing`, `ultrabrain`, `deep`
  gain a GPT-6 lead. `quick`, `unspecified-low`, `unspecified-high` are skipped.
- Agents: `sisyphus`, `prometheus`, `metis`, `atlas`, `sisyphus-junior` gain a
  GPT-6 lead. `hephaestus`, `oracle`, `momus` already lead with a `gpt-5.6-*`
  model and are upgraded to GPT-6. `librarian` and `explore` are skipped
  (deepseek rung).

Where this is authored (OMO package vs. in-repo snapshot) is open question 1.

## Components

- `packages/core/src/v1/config/config.ts`: declare `model_family`.
- `packages/opencode/src/plugin/ollama-model-router/provider-family.ts` (new):
  tier table, family order, dynamic resolution against `CatalogLike`.
- `packages/opencode/src/plugin/ollama-model-router/index.ts`: read
  `model_family` in the config hook and pass it into candidate selection.
- `packages/opencode/src/plugin/ollama-model-router/candidates.ts`: apply the
  family constraint before scoring.
- `packages/app/src/components/settings-v2/model-router.tsx` and
  `model-router-payload.ts`: dropdown plus form serialization.
- `packages/app/src/components/settings-v2/omo-catalog.ts`: keep the UI snapshot
  aligned with the authored runtime chains.

## Error Handling

- Unknown `model_family` value: config validation rejects it; the router
  treats an absent value as `"auto"`.
- Family with no matching model: fall through the family order, then current
  behavior.
- Catalog fetch failure: the override is skipped and routing proceeds as today.

## Testing

- Unit tests for the tier table and family fallback order in
  `packages/opencode/test/plugin/ollama-model-router/`.
- `parseOptions`/config validation test for `model_family`.
- Payload round-trip test for the new dropdown in `model-router-payload.test.ts`.
- Chain assertions in an `omo-catalog` test covering the deepseek/glm skip rule.
- App suites run with the project command:
  `bun test --conditions=solid --preload ./happydom.ts ./src`.

## Open Questions

1. **Where does the GPT-6 baseline live?** Resolved by evidence gathered
   2026-09-28:

   - The active plugin is `oh-my-openagent@4.19.4`
     (`~/.config/opencode/opencode.jsonc`). Its built `dist/index.js` contains
     **zero** `gpt-6` strings; it only ships `gpt-5.6-*`.
   - The GPT-6 family exists only on OMO `dev`
     (`packages/model-core/src/category-model-requirements.ts` has
     `gpt-6-astra`, `gpt-6-sol`, `gpt-6-sol-fast`, `gpt-6-luna-fast`).
   - npm `dist-tags`: `latest` and `beta` are `5.0.1`; `next` is `4.5.12`.
   - The git-plugin cache directory under
     `~/.cache/opencode/packages/oh-my-openagent@git+https:/` is **empty**, so
     no git install is materialized.

   Therefore editing `omo-catalog.ts` changes only Settings UI labels; it cannot
   make GPT-6 the runtime default. GPT-6 runtime defaults require an OMO build
   that contains them (the `dev` worktree does). Decision still required: is
   Flynncode expected to ship GPT-6 in the UI snapshot only, or is an OMO
   build/upgrade also in scope?
2. Note the live `~/.omo/omo.jsonc` pins almost every agent and category to an
   explicit `model`, which overrides built-in chain defaults regardless. If the
   GPT-6 baseline is expected to take effect on this machine, those pins are the
   controlling layer, not the chains.
3. Confirm the "Class to Model Mapping" table before implementation.
4. Confirm whether the override should also apply when the router plugin is
   disabled (current design: the key is read only by the router).
