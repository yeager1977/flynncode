# Model Router Settings Editor — Design

Date: 2026-09-15
Status: Approved

## Problem

The built-in Ollama model router (`packages/opencode/src/plugin/ollama-model-router`)
routes agents to ranked models from the `model_router` config key, but the app
surfaces nothing: no status, no assignments, no way to edit the scorecard
outside the config file. Users cannot discover or configure the feature.

## Goal

A "Model Router" tab in the V2 settings dialog that shows and edits the
`model_router` global config key end to end.

## Write Path

Reuse the existing server SDK config write (`serverSync().updateConfig`), with
one server-side fix:

- `Config.updateGlobal` deep-merges the patch. `patchJsonc` recursion can set
  keys but cannot delete them, so removing a scorecard model would not persist.
- Change: `model_router` is treated as a replaced subtree (whole-value swap)
  rather than a recursive patch. Verified experimentally: subtree replacement
  via `jsonc-parser` `modify(path=["model_router"])` deletes keys and preserves
  comments/formatting.

No new desktop IPC is required: the write goes through the SDK HTTP API the
desktop sidecar already serves.

## Tab Structure

New tab in `packages/app/src/components/settings-v2/dialog-settings-v2.tsx`
(Desktop section, `value="model-router"`, icon `models`, gated on desktop like
Plugins). Page component `packages/app/src/components/settings-v2/model-router.tsx`
with the mcp.tsx page pattern: header, sections, footer Save/Discard.

Sections:

1. **General** — `autoRoute` and `allowUnscored` switches (instant in local
   form state).
2. **Providers** — chips of provider IDs; add via select from connected
   providers; remove per chip.
3. **Agents** — rows of agent name → task; add/remove.
4. **Task weights** — six tasks × capability/price/speed numeric inputs.
5. **Scorecard** — one row per model: `providerID/modelID`, tags, and
   price/capability/speed (1–10). Add opens a dialog with a model picker
   (searchable, provider-grouped, from `useModels()`); delete with confirm.

Empty/absent config renders defaults (autoRoute on, standard agentTasks and
taskWeights, no providers filter, empty scorecard) so the form is never blank.

## Payload Module

`packages/app/src/components/settings-v2/model-router-payload.ts` — pure
functions, no context imports:

- `emptyForm()`, `formFromConfig(config)` — normalize the config key to form
  state (mirrors the plugin's defaults).
- `serializeForm(form)` — produce the `model_router` object written to config,
  omitting defaults where the plugin does.
- Validation mirroring the plugin's `parseOptions` rules: model keys
  `providerID/modelID`, integer scores 1–10, known task names, known agent
  names optional. Returns `{ ok: true, value } | { ok: false, errors }`.

Tested in `model-router-payload.test.ts` following `mcp-payload.test.ts`.

## Save and Apply Semantics

- Save writes the whole `model_router` subtree, toasts success/failure.
- Routing is applied at instance boot by the plugin's `config` hook, so the tab
  shows a "restart to apply" note; the toast states that routing re-applies on
  restart. No live re-routing is attempted.

## Tests

- Payload module unit tests (shape, validation, round-trip, default omission).
- Server test: `updateGlobal` with a `model_router` patch deletes removed keys
  and preserves comments plus unrelated keys.
- The plugin's existing tests keep passing unchanged.

## Out of scope

- No live re-routing without restart.
- No per-project `model_router` (global config key only).
- No model benchmarking or price fetching.
