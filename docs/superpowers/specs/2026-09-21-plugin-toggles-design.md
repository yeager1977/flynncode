# Model Router and Oh My OpenCode Toggles - Design

Date: 2026-09-21
Status: Draft

## Problem

Flynncode's Model Router is always on once `model_router` exists in config.
`autoRoute: false` does not fully disable it: the virtual `model-router/auto`
provider is still injected, `chat.message` still rewrites the sentinel, and
`rank_models` / `route_task` still register.

The user wants to try Oh My OpenCode (OMO) on this machine without deleting
router code or scorecards. OMO must not be bundled into Flynncode. The two
features need independent on/off switches in Settings, persisted in config.

## Goal

Keep both systems installed. Add a Settings master switch for each. Default
this machine to Model Router off and OMO on. Restart is required for either
change.

## Scope

In scope:

- `model_router.enabled` parsed by the built-in router plugin.
- A Settings switch on the existing Model Router tab.
- A Settings switch that adds or removes `oh-my-openagent` from the global
  `plugin` array without deleting `~/.omo/` or scorecards.
- Installing OMO on this machine with the official installer.
- If the session model is `model-router/auto` when the router is turned off,
  retarget it to `small_model` (currently `ollama-cloud/glm-5.3-flash`).
- Tests for `enabled: false` leaving the plugin inert.

Out of scope:

- Bundling OMO into the Flynncode repo.
- Hot-reload (config is load-once).
- Changing scoring, categories, or OMO internals.
- Mutually exclusive enforcement beyond the chosen defaults.

## Approaches considered

1. **Config flag + Settings switches (chosen).** Router stays loaded but
   inert when `enabled` is false. OMO toggle only edits `plugin[]`.
2. Config-only flags with no Settings. Hidden; easy to leave on by accident.
3. Delete or comment config keys. Contradicts "leave everything there."

## Behavior

### Model Router `enabled`

- Type: boolean. Default `true` when the key is omitted, so existing configs
  keep routing.
- This machine's `~/.config/opencode/opencode.jsonc` sets `"enabled": false`.
- When `enabled` is false, `parseOptions` still succeeds and keeps scorecard
  data, but the plugin config hook must not inject `model-router`, must not
  assign agent models, and must not register routing tools. `chat.message`
  must not rewrite.
- Settings keeps the Model Router tab and scorecard. The master switch sits
  at the top. Other controls stay visible but do not apply until the switch
  is on and OpenCode is restarted.
- Saving the switch writes `model_router.enabled` through the existing
  settings save path. Copy uses i18n keys; English is the source.

### Oh My OpenCode toggle

- This machine only. Run `bunx oh-my-openagent install` (or the documented
  `oh-my-opencode` alias) into the user config. Do not vendor the package.
- On: `plugin` contains `oh-my-openagent` (legacy `oh-my-opencode` still
  counts as on).
- Off: remove those entries from `plugin`. Leave `~/.omo/omo.jsonc` and the
  npm/bun cache in place so turning it back on does not re-interview.
- Settings switch lives with the Model Router switch so both are findable.
  Persist by patching global `opencode.jsonc` with the jsonc parser (preserve
  comments).
- Default after install: on.

### Session model when disabling the router

If `model` is `model-router/auto` (or provider `model-router`), write
`model` to the configured `small_model`. Do not invent a new default. If
`small_model` is missing, leave `model` unchanged and surface the existing
settings error path rather than guessing.

## Testing

- `parseOptions` accepts `enabled` and defaults it to `true`.
- With `enabled: false`, the config hook does not inject the sentinel
  provider and does not mutate agents.
- Tools report disabled when `enabled` is false.
- Settings serialize `enabled: false` and round-trip it.
- Plugin-array helper: adding/removing `oh-my-openagent` does not drop other
  plugin entries.

## Verification

- After install, `plugin` includes `oh-my-openagent` and `model_router.enabled`
  is false.
- `model` is not `model-router/auto`.
- Restart OpenCode. Model picker has no Model Router sentinel. OMO agents or
  commands are present.
- Flip the router switch on, save, restart: sentinel returns.
- Flip OMO off, save, restart: OMO is gone; `~/.omo/` remains.

## Risks

- **OMO vs router.** Mitigated by defaulting the router off on this machine.
  The product does not hard-forbid both on.
- **Installer mutates config.** Run it first, then apply `enabled: false` and
  the model retarget so the installer cannot re-select the sentinel last.
- **Unknown top-level keys.** `model_router` is already a Flynncode key.
  `enabled` lives under it, not at the root, so OpenCode schema rejection
  does not apply.
