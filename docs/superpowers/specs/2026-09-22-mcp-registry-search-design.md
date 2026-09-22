# MCP Registry Search - Design

Date: 2026-09-22
Status: Draft

## Problem

Flynncode's MCP settings tab supports adding servers by hand-typing commands
and URLs. The official MCP Registry
(`registry.modelcontextprotocol.io`) exposes a CORS-open REST API for
discovering publicly available servers with structured install metadata
(package, runtime hint, transport, env vars). Today that data has to be
re-typed manually.

## Goal

A "Search registry…" entry point in the MCP settings tab that searches the
official registry, lets the user pick a result, and prefills the existing
add-server form — reviewable, editable, and saved to project or global
config through the existing add path.

## Scope

In scope:

- Registry search dialog inside the MCP tab (opened by a new button next to
  "Add"): search box (debounced ~300ms + Enter), transport filter
  (stdio/remote), paginated result list, Select action per row.
- `GET https://registry.modelcontextprotocol.io/v0.1/servers` with
  `search`, `limit=30`, cursor pagination (`metadata.nextCursor`);
  client-side transport filtering on the fetched page (the API supports
  name search only).
- Mapping module converting a registry entry to a prefilled `McpFormState`:
  - npm package (`runtimeHint` npx): local command
    `npx -y <identifier>@<version>` (bare `<identifier>` when version
    missing) plus `runtimeArguments`.
  - docker/oci packages: `docker run -i --rm -e <envName...> <image>`.
  - `remotes[]` entries: remote config with `url`.
  - Env rows prefilled from `environmentVariables[]`: `default` value if
    present else blank; description as placeholder; `isSecret`/required
    surfaced in the row hint.
  - Server name: last path segment of the reverse-DNS name
    (`io.github.user/filesystem` → `filesystem`), deduped `-2`, `-3`
    against existing server names.
  - Unsupported package types (no mappable package and no remote) disable
    Select with an explanation.
- Scope toggle in the existing add form: `Global` / `Project`, shown when
  a project directory is active; `McpFormState.scope` +
  `buildAddInput` returns `directory`; `mcpApi().add()` includes `directory`
  only for project scope. Defaults to Project when directory exists.
  Edit flow keeps the server's original scope: the toggle is initialized
  from where the server was loaded (project `mcp` map if the name is
  present there, else global), and the remove+add round-trip targets that
  same scope for both remove and re-add.
- Registry fetch errors: inline retry note in the dialog; the rest of the
  tab keeps working. 5s fetch timeout.

Out of scope:

- Third-party directories (Smithery, PulseMCP) as sources.
- One-click install without review, JSON preview step.
- OAuth/header hints from registry metadata (manual after prefill).
- Publishing to the registry.

## Approach

- `packages/app/src/components/settings-v2/mcp-registry.ts`: pure mapping
  + typed fetcher (`searchRegistry`, `registryToForm`). No UI imports.
- `packages/app/src/components/settings-v2/mcp-registry.tsx`: dialog UI
  (search, filters, list, Select), reusing `settings-v2-plugins-note`,
  `Tag`, `ButtonV2`, `TextInputV2` patterns.
- `mcp.tsx`: "Search registry…" button; selection calls existing
  `openForm(registryToForm(...))`. `addServer` threads the `directory`
  from `buildAddInput` into `mcpApi().add()` — present for project scope,
  absent for global. Edit path keeps the server's previous scope.
- `mcp-payload.ts`: `scope` on `McpFormState`, `directory` in
  `buildAddInput` output; `emptyForm`/`formFromConfig` updated.
- i18n keys under `settings.mcp.registry.*` in the language files the tab
  already uses.

## Testing

- `mcp-registry.test.ts`: npm→command with version pin + runtime args,
  docker variant, remote variant, env prefill (default/secret/required),
  name derivation + dedupe, unsupported-type rejection, query/params
  building.
- `mcp-payload.test.ts`: scope in `buildAddInput`, form round-trip.
- Run from `packages/app` per repo testing rules.