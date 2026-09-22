# Oh My OpenCode Model Settings — Design

Date: 2026-09-21
Status: Draft, awaiting review

## Problem

Oh My OpenAgent picks models from a built-in fallback chain unless a pin exists
in its own config file. This machine has no `oh-my-openagent.jsonc`, so that
chain is in force. The only built-in Grok use is the `quick` category
(`xai/grok-4.20-0309-non-reasoning`). A session on `xai/grok-4.7` got there
because that model was selected in the picker, not because the chain chose it.

Settings can turn the plugin on and off. It cannot pin an agent or category
model, and it cannot ban a provider in a way that hides it from the picker.
The Providers screen can Edit and Disconnect. Disconnect removes credentials.
A provider added to `disabled_providers` disappears from the connected list, so
it cannot be turned back on.

## Goal

Two settings surfaces:

1. A new Oh My OpenCode tab that pins built-in agent and category models, shows
   the known fallback when a pin is empty, and bans providers globally or for
   the current project.
2. A switch on each configured provider row in the existing Providers screen.
   On and off write global `disabled_providers`. Edit stays. Disabled rows stay
   visible. Credentials stay.

Restart is required. A model already selected in the picker still wins until
the next session.

## Scope

In scope:

- New Settings tab, next to Model Router.
- Read and write of the Oh My OpenAgent config files through new server
  endpoints. The renderer does not write those files.
- Global and current-project pins and provider bans.
- Provider-ban writes to OpenCode `disabled_providers`, so the picker hides the
  provider. An Oh My OpenAgent ban alone does not.
- Enable/disable switch on the Providers screen, global only.
- English i18n keys, spread into other locales through the existing
  fallback-module pattern so parity tests pass. No invented translations.
- Payload tests and server tests. No new browser end-to-end test.

Out of scope:

- Moving the existing plugin on/off switch. It stays on the Model Router tab.
- A second on/off switch on the new tab.
- Temperature, prompts, hooks, skills, or a `fallback_models` editor.
- Clearing a global pin back to Automatic from the project file.
- Un-banning a global OpenCode provider from the project scope.
- Project scope on the Providers screen.
- Editing `model_router`.
- Hot reload.
- Invented translations. Locales receive the English string through a
  fallback module, as `model-router-fallback.ts` does.
- Importing the `oh-my-openagent` package into the app.

## Approaches considered

1. **New tab plus a Providers switch (chosen).** The tab edits the real plugin
   files and the OpenCode ban list. The Providers switch edits only the global
   OpenCode ban list. Edit stays beside the switch.
2. Section inside Model Router. Rejected. It mixes Flynncode routing with Oh
   My OpenAgent routing.
3. Ban only, pins as a JSON snippet. Rejected. Pins would not be saved.
4. Enable/disable inside the provider edit dialog. Rejected. The row switch
   is the control; Edit stays the config dialog.

## How a model is chosen

Oh My OpenAgent resolves in this order. First match wins.

1. Model selected in the picker.
2. Explicit `agents.<name>.model` or `categories.<name>.model`.
3. `fallback_models` on that agent or category.
4. Built-in chain, first connected provider.
5. OpenCode `model`.

An explicit pin skips the chain. UI selection skips the pin. Disabling the
provider in OpenCode removes it from the available set, so neither the picker
nor the chain can select it.

## Files

Plugin config, first existing file wins. Write back to that file. If none
exists, create `oh-my-openagent.jsonc`.

| Scope | Directory | Names, in order |
|---|---|---|
| Global | `~/.config/opencode/` | `oh-my-openagent.jsonc`, `oh-my-openagent.json`, `oh-my-opencode.jsonc`, `oh-my-opencode.json` |
| This project | `<directory>/.opencode/` | same four names |

OpenCode bans:

- Global: the file `globalConfigFile()` already selects under
  `~/.config/opencode/` (`opencode.jsonc` on this machine).
- This project, in this order, and only inside the settings directory:
  `<directory>/.opencode/opencode.jsonc`,
  `<directory>/.opencode/opencode.json`,
  `<directory>/opencode.jsonc`,
  `<directory>/opencode.json`.
  Patch the first that exists. `.opencode/` wins because the loader applies
  it after a root `opencode.json`. If none exist, create
  `<directory>/.opencode/opencode.jsonc`.
  Do not edit a parent directory's config. Do not call `Config.update`.
  That method writes `<directory>/config.json`, which the loader does not
  use as project OpenCode config.

A project OpenCode `disabled_providers` array replaces the global array. A
project plugin `disabled_providers` array is unioned with the global plugin
array.

JSONC edits use `jsonc-parser` `modify`, so comments and unknown keys stay.
A `.json` file is parsed, patched, and written with `JSON.stringify`. Unknown
keys stay. The `disabled_providers` array is replaced with the computed set.
It is not deep-merged, because a merge cannot remove an unchecked id.

## Server API

Add HttpApi endpoints, then run `bun run generate` from `packages/client`.
Do not edit `src/generated` or `src/generated-effect` by hand.

- `GET` and `PUT` `/global/omo-config` on the global API.
- `GET` and `PUT` `/config/omo` on the instance API. The directory is the one
  the settings dialog already sends.

`GET` returns the parsed plugin document, the path, OpenCode
`disabled_providers` for that scope, and a parse error string when the file
exists but does not parse. A missing file is an empty document and a null
path, not an error.

`PUT` accepts agents, categories, and `disabledProviders`. One handler writes
the plugin file first, then the OpenCode ban. The response names the file
that failed. There is no rollback. A failed OpenCode write can leave a pin
saved while the provider remains in the picker. The error text says that.

The Providers switch does not use these endpoints. It calls the existing
global config update and changes one id in `disabled_providers`.

## Oh My OpenCode tab

The tab is in `dialog-settings-v2.tsx`, Desktop section, beside Model Router.
If the plugin is absent from `plugin`, the tab shows that and still allows
editing. It does not add a second switch.

### Scope

A Global / This project control at the top.

Global edits the user plugin file and global OpenCode `disabled_providers`.
This project edits the project plugin file and the project OpenCode file.
The project plugin file stores only differences.

### Provider bans

A checkbox list of connected providers, plus any provider id already banned
that is not connected. The checked set is seeded from the union of that
scope's OpenCode `disabled_providers` and its plugin `disabled_providers`.
xAI is labeled as the Grok provider. Ids that are not shown are left
untouched in the file.

Global: checked means banned everywhere. Unchecking removes that id.

This project: providers banned in either global list, OpenCode or plugin,
are checked and locked. Extra checks mean also banned here. Saving writes the global OpenCode
bans plus those extras into the project OpenCode file, so `ollama-local`
stays banned. The project plugin file gets only the extras. An empty extra
list omits the plugin `disabled_providers` key.

### Agents and categories

One row: name, one-line purpose, model menu.

Built-in agents: Sisyphus, Hephaestus, Oracle, Librarian, Explore, Multimodal
Looker, Prometheus, Metis, Momus, Atlas, Sisyphus Junior.

Built-in categories: visual-engineering, ultrabrain, deep, artistry, quick,
unspecified-low, unspecified-high, writing.

Global menu: Automatic, or a connected `provider/model`. A variant field
appears only after a model is chosen. Empty variant omits the key.

This project menu: Inherit, or a connected model. Inherit writes nothing.
A project file cannot clear a global pin, so Automatic is not offered here.
Variant appears only when a project model is set.

A saved pin that is not in the connected catalog stays selected, with a not
connected note. Save keeps it unless the user changes that row. The menu does
not accept free text.

Under Automatic or Inherit, a muted line shows the known fallback: the first
built-in chain entry whose provider is connected, or the chain head plus not
connected. The label says this is the known default, not a live matcher and
not a guarantee after a plugin update.

The chain catalog is a static snapshot copied at implementation from
`AGENT_MODEL_REQUIREMENTS` and `CATEGORY_MODEL_REQUIREMENTS` in the installed
`oh-my-openagent` package. The app does not import that package and does not
parse it at runtime.

### Save

Automatic removes that agent or category `model` and `variant` only. Other
keys on the object stay. If the object is then empty, omit the key.

A pin writes `model`, and `variant` only when filled.

Global `disabled_providers` in both files is the set of providers checked on
the global form, plus any banned id the form did not show.

Project plugin save writes only non-Inherit rows and extra bans. If that
leaves a file this handler created with no remaining keys, delete it. Do not
delete a file that still has unrelated keys.

Footer: Save, an unsaved marker, and one line that quit and restart is
required and that a picker selection still wins until the next session.
Success toast repeats that. The form stays dirty when a write fails.

Invalid JSONC disables Save and is not overwritten.

## Providers screen

Each configured provider row keeps Edit and gains a switch beside it.

The row list is the connected catalog plus every id in global
`disabled_providers`. A disabled id that the catalog omits still renders.
Name comes from `config.provider` when present, otherwise the built-in
provider name, otherwise the id. The row is visually off when disabled.

The switch saves immediately. On removes that id from global
`disabled_providers`. Off adds it. Other ids stay, including `ollama-local`.
The write is the existing global config update, not `Config.update`, and it
is not gated on protocol v1. Failure restores the previous list and shows the
existing request-failed toast.

The switch does not remove the API key, the auth record, or the
`provider` config block. Disconnect remains that action and keeps its current
rules, including the environment-provider hint.

This screen has no project scope. A project ban on the Oh My OpenCode tab
still applies in that project after a global re-enable.

## Testing

Payload function, same style as `model-router-payload.test.ts`:

- Automatic omits `model` and `variant` and keeps other keys.
- A pin writes `model`, and `variant` only when set.
- Inherit omits the project key.
- A project OpenCode ban is the global list plus extras, including
  `ollama-local`.
- A project plugin ban is extras only.
- An already-banned provider that is not connected stays in the saved set.
- An id the form did not show is not removed.

Server tests:

- A missing plugin file reads as empty.
- Invalid JSONC refuses the write.
- A project save writes both files and does not drop `ollama-local`.
- The project OpenCode write does not create `<directory>/config.json`.
- A failed OpenCode write returns the failing path and does not claim both
  writes succeeded.

Providers switch:

- Adding one id does not drop the others.
- Removing one id does not drop the others.
- A disabled id with no catalog entry is still in the row list.

No new Playwright spec.

## Verification

- With no plugin file, the tab shows Automatic and the known fallback.
- Pin Sisyphus to `ollama-cloud/glm-5.3`, save, restart, new session: that
  agent uses the pin unless the picker overrides it.
- Ban xAI globally from either surface, restart: `xai` is absent from the
  picker. The provider row remains, off, and Edit still opens.
- Turn xAI back on from the Providers switch, restart: it returns. A project
  ban of xAI still hides it in that project.
- Ban xAI for one project: that project's OpenCode file contains the previous
  global bans plus `xai`. `ollama-local` stays banned. No `config.json` is
  created.

## Risks

- **Chain snapshot drift.** The fallback line can be wrong after an
  oh-my-openagent update. The label says it is a known default. Do not parse
  the plugin at runtime to fix this.
- **Partial save.** A pin can land without the OpenCode ban. The error names
  the file. No rollback, by decision.
- **Two editors, one array.** The Providers switch and the global Oh My
  OpenCode ban list both write global `disabled_providers`. Each write
  preserves ids it did not show. A stale Oh My OpenCode form can still
  overwrite a switch change for an id that form did show. Accept that. Do not
  add cross-tab locking.
- **Project array replace.** Writing only `["xai"]` into a project OpenCode
  file would re-enable `ollama-local`. The handler writes the union.
