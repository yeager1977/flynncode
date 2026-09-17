# Provider Connection Edit - Design

Date: 2026-09-17
Status: Approved

## Problem

Connected providers appear in Settings with a source tag and a Disconnect action.
The only connection field a user can change from the UI is the Ollama Cloud API
key, through the `canReplaceProviderApiKey` gate in
`packages/app/src/hooks/provider-catalog.ts`. Every other connection setting --
base URL, headers, models, API key -- can only be changed by hand-editing
`opencode.json(c)` or by deleting the provider and re-creating it through the
custom-provider create flow. That create flow refuses existing provider IDs, so
there is no supported way to revise an existing connection.

## Goal

Let a user edit the connection settings of any connected provider from the v2
Settings page. The edit form must be prefilled from the provider's current
connection state, must never display or return a stored secret, and must persist
changes to global config plus the auth store.

## Scope

In scope:

- An Edit action on every connected-provider row in the v2 providers settings.
- A new edit dialog for API key, base URL, headers, and (config-defined) models.
- A server config-patch change so clearing a field persists.

Out of scope:

- The legacy `settings-providers.tsx` layout. It keeps its current behavior.
- Project-scoped config writes. Edits go to global config, matching the
  custom-provider create flow.
- Non-v1 servers. The Edit action is hidden, matching the existing
  custom-provider and disconnect gating.
- Displaying, revealing, or pre-filling an existing secret.
- Changing provider ID for an existing provider.

## UX and Entry Point

Every row in the v2 "Connected providers" section gains an **Edit** action,
replacing the Ollama Cloud-only affordance at
`packages/app/src/components/settings-v2/providers.tsx:178`. The action opens a
new `DialogEditProvider`, prefilled from the provider's effective connection
state. The v2 settings page stops gating Edit on `canReplaceProviderApiKey`. The
helper stays for the legacy layout, which still uses it at
`packages/app/src/components/settings-providers.tsx:179`.

The dialog has three sections:

- **Auth**: for API-key and env connections, a masked, write-only key field
  (blank means "keep the existing credential"). For OAuth connections, a
  read-only "Connected via OAuth" line plus a "Use an API key instead" action
  that writes an `api` credential over the OAuth credential.
- **Connection**: an optional base URL and header key/value rows.
- **Models**: only for config-custom providers, prefilled from config. Hidden
  for built-in providers.

Save and Cancel actions follow the existing `DialogCustomProvider` layout, with a
success toast on save and the existing error treatment on failure.

## Prefill and Auth Detection

Prefill sources:

- Base URL and headers: `serverSync().data.config.provider[providerID].options`,
  from the global config store already loaded through `global.config.get`
  (`packages/app/src/context/global-sync/bootstrap.ts:113`).
- Models: `config.provider[providerID].models`, rendered only when the provider
  matches the config-custom shape used by `isConfigCustom`
  (`packages/app/src/components/settings-v2/providers.tsx:90`): `npm` is
  `@ai-sdk/openai-compatible` and the model list is non-empty.
- API key: never prefilled or displayed. `toPublicInfo` strips `key` and
  `options.apiKey` (`packages/opencode/src/provider/provider.ts:1122`), and the
  config store carries no secret.

Auth kind:

- The Edit action is available only under the v1 protocol, consistent with the
  existing custom-provider section (`packages/app/src/components/settings-v2/providers.tsx:244`)
  and `disableProvider` (`packages/app/src/components/settings-v2/providers.tsx:99`),
  and required because the app reads and writes config only under v1: the global
  config query returns `{}` otherwise
  (`packages/app/src/context/global-sync/bootstrap.ts:112`).
- Under v1, use the provider `source`: `env` (key field read-only with an
  environment hint), `api` or `config` (key field editable), and `custom`
  (plugin/OAuth loader, treat as OAuth).

## Save Path

Two writes, matching the custom-provider create flow
(`packages/app/src/components/dialog-custom-provider.tsx:132`):

1. If the user entered a non-empty key, call
   `client.auth.set({ providerID, auth: { type: "api", key } })`.
2. Call `serverSync().updateConfig(...)` with the provider subtree plus
   `disabled_providers` with this provider removed, then `refreshProviders`.

An empty key writes no credential, so an existing credential survives. Refresh
invalidates provider queries the same way the existing `updateConfigMutation`
does (`packages/app/src/context/server-sync.tsx:660`).

## Removing Fields

Config updates merge additively. `mergeDeep` and `patchJsonc` only write leaves
present in the patch, so clearing a header or blanking a base URL cannot persist
-- the previous value survives. The existing `model_router` handling already
solves this with a whole-subtree swap (`config.ts:163` and `config.ts:680`).

Add a matching `provider` exception: when a patch contains `provider`, each
provider entry present in the patch replaces that provider's subtree in the
config, while all other providers and config keys merge normally. Implement this
in both `patchJsonc` and the non-jsonc branch of `updateGlobal`. Only two client
paths write provider config (the custom-provider dialog and the new edit
dialog), and the create flow always sends a complete provider entry, so the
subtree replacement is safe for both.

## Validation and Errors

- Reuse `dialog-custom-provider-form.ts` for base URL format (`^https?://`),
  header duplicate-key checks, and model id/name required and unique checks.
- Base URL is required for config-custom providers and optional for built-in
  providers, where empty means the catalog default.
- A save failure keeps the dialog open and shows the existing request-error
  treatment. A failure never reports success.
- Secrets must not appear in provider-list responses, logs, toasts, tests, or
  error messages.

## Testing

- Config unit tests: a provider-entry patch replaces that provider's subtree,
  removes headers and blanked values, and preserves sibling providers and other
  config keys, for both the jsonc and non-jsonc paths.
- Helper unit tests: prefill extraction and auth-kind detection for env, api,
  config, and custom (OAuth) sources.
- Validation unit tests: base URL optional versus required, header and model
  rules.
- App component tests: Edit appears on every connected row, and a blank key
  leaves the stored credential untouched.
- Run app and opencode unit tests, typechecks from package directories, and a
  browser check via the app dev server against the backend.

## Localization

Add new keys for the edit dialog title, the OAuth read-only copy, and the "use an
API key instead" action, mirrored across every locale file in
`packages/app/src/i18n/` because the parity test requires it. Reuse
`provider.custom.field.*`, `provider.custom.models.*`, `provider.custom.headers.*`,
`provider.custom.error.*`, `common.edit`, `common.saving`, `common.submit`, and
`provider.connect.method.apiKey` where they already fit.

## Packaging

No packaging change. The work ships with the next desktop build.
