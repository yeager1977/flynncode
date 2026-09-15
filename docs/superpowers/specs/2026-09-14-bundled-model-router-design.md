# Bundled Ollama Model Router Plugin — Design

Date: 2026-09-14
Status: Approved

## Problem

The Ollama model router plugin lives at the repo root (`ollama-model-router/`)
and is loaded by absolute path from the user's global config. That path points
at the legacy clone (`~/GitHub/opencode`), so the feature is not part of the
built desktop app and breaks on any machine without that clone.

## Goal

Ship the model router inside the app build so it loads by default, with its
scorecard and options configured through opencode's global config.

## Approach

### 1. Bundle as an internal plugin

Move the plugin implementation into the server package:

```
packages/opencode/src/plugin/ollama-model-router/
  index.ts        plugin factory: server(input) -> Hooks
  candidates.ts
  rank.ts
  scorecard.ts
  assign.ts
  tools.ts
  types.ts
```

`packages/opencode/src/plugin/index.ts` already imports built-in plugins
(`xai`, `cerebras`, copilot auth, ...) and registers them in
`internalPlugins(flags)`. Add the router there, exported as a
`PluginInstance` (`(input, options?) => Promise<Hooks>`). Internal plugins are
compiled into the bundled server (`dist/node/node.js`), which electron-vite
inlines into the desktop main process, so no packaging changes are needed.

Registering internally means:

- Loads by default on desktop, CLI, and server.
- Respects `OPENCODE_DISABLE_DEFAULT_PLUGINS`.
- No path dependency on a local clone.

The module keeps its `default { id, server }` export so it remains loadable
as an external path plugin during a transition period.

### 2. Options in the global config

The config schema (`packages/core/src/v1/config/config.ts`, `Info` struct)
gains an optional `model_router` key. Without a schema entry the decoder
strips unknown keys (`onExcessProperty: "ignore"`), so the plugin would never
see it.

The plugin resolves options in this order:

1. `cfg.model_router` (the new global config key).
2. The plugin options tuple (external load compatibility).
3. Built-in defaults.

Option validation and defaults are unchanged; invalid options disable routing
with a warning instead of throwing, as today.

### 3. Config migration

The user's `~/.config/opencode/opencode.jsonc` drops the absolute-path plugin
tuple and moves its options object to a top-level `model_router` key. Loading
both would register the plugin twice.

### 4. Tests

The plugin's unit tests move to
`packages/opencode/test/plugin/ollama-model-router/` (imports adjusted to the
new source location). One new test covers options resolution from
`cfg.model_router` vs the tuple fallback.

### 5. Build and verify

Rebuild the dev deb, then verify:

- `[ollama-model-router]` code is present in the bundled server and the packed
  `app.asar`.
- A launch with a `model_router` config logs the `agent routing:` line and
  exposes `rank_models`/`route_task` tools.

## Out of scope

- No desktop settings UI for the scorecard.
- No change to scoring, ranking, or task weights.
- No auto-updating of upstream `ollama-model-router/` at the repo root: the
  root copy becomes source history only.
