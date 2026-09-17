# Ollama Cloud Provider Visibility - Design

Date: 2026-09-16
Status: Approved

## Problem

Ollama Cloud is available in the provider catalog, but it is absent from the
shared `popularProviders` ordering. Users therefore see it only after opening
"Show more providers" rather than in the main Settings provider list.

## Goal

Show Ollama Cloud directly in the main Popular providers list while preserving
the existing provider metadata, connection flow, and authentication behavior.

## Design

- Add `ollama-cloud` to the shared `popularProviders` ordering in
  `packages/app/src/hooks/use-providers.ts`.
- Place it with the direct model providers so every consumer of the shared
  ordering presents Ollama Cloud consistently.
- Continue sourcing its display name, models, and connection methods from the
  existing provider catalog. Do not add provider-specific rendering or data.
- Keep the full provider list and disabled-provider reconnection behavior
  unchanged.

## Verification

- Add a focused regression test that asserts Ollama Cloud is in the shared
  popular-provider ordering at the intended position.
- Run the relevant app tests and typecheck.
- Browser-check Settings > Providers and confirm Ollama Cloud appears in the
  main Popular providers section without opening "Show more providers".

## Out of Scope

- Provider API, credentials, model definitions, and endpoint configuration.
- Changes to the popularity or ordering of unrelated providers.
- Ollama Local visibility.
