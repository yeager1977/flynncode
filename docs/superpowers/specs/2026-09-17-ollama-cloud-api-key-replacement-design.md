# Ollama Cloud API Key Replacement - Design

Date: 2026-09-17
Status: Approved

## Problem

Ollama Cloud can be configured from three credential sources: provider config,
the `OLLAMA_API_KEY` environment variable, and Flynncode's saved auth store. A
key entered through Flynncode is currently saved, but an older
`provider.options.apiKey` still wins when model discovery and the provider SDK
are created. The UI then reports a successful connection even though requests
continue using the stale configured key.

Disconnecting a config-defined Ollama Cloud provider removes the newly saved
credential and disables the provider. This leaves the stale config and
environment values in place, so reconnecting is confusing and can return the
same unauthorized error.

## Goal

Let users replace the Ollama Cloud API key directly from Settings. A key saved
through Flynncode must be the effective credential for discovery and model
requests, without displaying the existing secret or rewriting external config.

## Credential Precedence

For an API key explicitly saved through Flynncode:

1. The saved auth-store key is authoritative.
2. Config and environment keys are fallback sources only when no saved key
   exists.
3. Config metadata such as the provider name, base URL, npm package, and model
   catalog continues to merge normally.
4. Merging config metadata must not relabel a provider backed by saved auth as a
   config credential. Its effective source remains `api`.

The same saved key must be used by model discovery and by the runtime SDK. The
two paths must not resolve credential precedence independently.

## Settings Flow

The connected Ollama Cloud row gains a **Replace API key** action next to
Disconnect. The action opens the existing provider connection dialog, which
automatically selects Ollama Cloud's API-key method and presents an empty,
masked input. Flynncode never returns or pre-fills the stored key.

Submitting a non-empty key uses the existing auth connection endpoint. After
the credential is saved, Flynncode removes `ollama-cloud` from
`disabled_providers`, refreshes provider state, closes the dialog, and shows the
existing success toast.

The action is intentionally limited to Ollama Cloud in this revision. Other
providers retain their current authentication flows until their precedence and
refresh requirements are evaluated independently.

## Disconnect Behavior

Disconnect continues to remove the Flynncode-saved credential and disable the
config-defined Ollama Cloud provider. Disabling prevents an older fallback key
from becoming active silently after the saved key is removed.

The next connection or replacement must explicitly save a key before the
provider is re-enabled.

## Error Handling

- Empty input remains blocked by the existing required-field validation.
- A credential-save, config-update, or provider-refresh failure keeps the
  dialog open and displays the existing request error treatment.
- Failed replacement must not report success.
- Secrets must not appear in provider-list responses, logs, toasts, tests, or
  error messages.

## Testing

- Add provider tests proving saved API auth overrides a stale config API key.
- Verify the effective provider source remains `api` after config metadata is
  merged.
- Verify model discovery and runtime SDK construction select the same saved
  credential.
- Add app coverage for the Ollama Cloud replacement action and the existing
  reconnect/re-enable sequence.
- Run app and opencode unit tests, browser tests, affected package typechecks,
  the production desktop build, and DEB packaging.

## Packaging

Build the next local dev revision after all checks pass. Validate the Debian
package metadata and copy the versioned artifact to `~/Downloads` without
installing or restarting the running app automatically.

## Out of Scope

- Automatically editing shell startup files or environment variables.
- Rewriting API keys in project or global config files.
- Displaying, revealing, or pre-filling an existing key.
- Generalizing credential replacement UI to every provider.
