# Meta model discovery and Muse Wonder Full

## Goal and evidence

Make Muse Wonder Full selectable immediately and automatically discover new
Meta chat models without waiting for the shared model catalog to update.

The installed Muse CLI uses a browser/device-code credential. Flynncode's stored
Meta credential matches it. An authenticated `GET https://api.meta.ai/v1/models`
returns `muse-wonder-full-1.0`, but the cached catalog only contains
`muse-wonder-1.0`. No additional login is needed.

## Approved approach

Add `muse-wonder-full-1.0` to the user's active global Meta configuration. Preserve
the surrounding JSONC and use the existing Wonder metadata as family defaults;
these inherited limits and capabilities are fallback metadata, not separately
verified Full-specific specifications. Keep the Meta Responses SDK.

In the existing provider initialization flow, discover models for connected,
allowed Meta providers after credentials and configuration options have been
resolved. Use the same effective API key and base URL as inference. Reuse the
bounded `/models` discovery transport rather than adding a new authentication
mechanism or background poller.

Merge discovered Muse chat models into the resolved Meta model list. Preserve
existing model definitions, explicit configuration overrides, custom aliases,
reasoning variants, and model filters. New Muse models use a matching catalog
family model as fallback metadata and retain their own API identifiers and
display names. Explicit metadata from the endpoint takes precedence over
inherited fallback values. Standalone image, voice, transcription, segmentation,
embedding, and other non-chat endpoints do not become chat model choices.

The regular and Full Wonder models have distinct identities and display names.
Contributor variants keep their contributor designation and follow the existing
Meta contributor confirmation behavior.

## Lifecycle and errors

Discovery happens when the directory-scoped provider state is initialized or
rebuilt through the existing catalog refresh lifecycle. The model router already
consumes the connected provider catalog and invalidates its snapshot on catalog
refresh, so discovery results must flow through that existing path.

Disconnected or disabled Meta providers make no discovery request. HTTP failure,
timeout, malformed response, or an empty compatible-model list preserves the
catalog/config list. Discovery does not expose credentials in diagnostics.

## Verification

Use a local HTTP server to exercise the actual provider implementation. Cover:

- Missing Full and future Muse models becoming available with Responses support.
- Preservation of existing metadata, overrides, aliases, and reasoning variants.
- Authentication precedence and endpoint selection matching inference.
- Exclusion of non-chat endpoints and enforcement of provider/model filters.
- Fallback on failed, malformed, or empty discovery responses.
- The connected model-router catalog recognizing discovered Meta models.
- Contributor confirmation covering newly discovered contributor variants.

Run focused tests from the relevant package directories and `bun typecheck` in
each changed package. Validate the local configuration through Flynncode's
configuration/provider loader and inspect the resolved Full model entry. A
restart is required for the installed application to load configuration changes;
source-code changes also require a rebuilt application/server.

## Scope

Implement discovery inside Flynncode's existing provider lifecycle. Do not add
another login flow, change the public API, or modify generated clients.
