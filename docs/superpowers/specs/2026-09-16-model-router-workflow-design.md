# Model router workflow redesign

Date: 2026-09-16

The user requested a complete layout/workflow improvement and asked to proceed
directly without browser mockups or further design approval gates.

## Experience

- Keep the existing Model Router settings entry. Use a persistent header for
  Save/Discard and a visible saved/unsaved state and apply-on-restart explanation.
- Split the page into Routing, Models, and Advanced, with keyboard-accessible
  navigation and responsive, direction-aware cards.
- Routing shows automatic routing, agent-to-task mappings, task priority presets,
  and the top matching model for each task. Previews are explicitly advisory,
  based on global provider definitions and draft scores; project overrides and
  explicit agent models can change actual assignments. Do not present previews
  as live runtime status.
- Models shows searchable, readable model names and provider names. Bulk-add
  from configured candidates using checkboxes. Keep unavailable saved models
  visible with explanatory status. Expand one model to edit three labeled 1–10
  sliders and select supported tasks with chips. Empty tags mean all tasks.
- Advanced contains provider scope, fallback/override switches, and exact
  relative task weights. Empty provider selection explicitly means automatic
  Ollama-provider selection. Weight errors appear next to the affected controls.
- Empty states explain the next action. Removing models updates the draft;
  Discard restores saved state. Editing never silently deletes partial text.

## Data and boundaries

Continue writing the whole `model_router` subtree through
`serverSync().updateConfig`. Preserve the plugin's existing configuration shape
and runtime behavior. Use the provider catalog's Map API correctly. Follow
incoming configuration while the editor is pristine, preserve local edits during
background refresh, and establish a local saved baseline after successful writes.

Keep preview/catalog/preset calculations in a pure app module, separate from
Solid components. Protect preview compatibility with contract tests against the
existing plugin's actual candidate collection and ranking implementations (test
imports only). Candidate enumeration, provider filtering, disabled providers,
task tags, unscored fallback, weight normalization, and tie breaking must match.

## Verification

- Unit coverage for invalid task weights, duplicate agent mappings, preview
  eligibility/ranking, and presets.
- Browser coverage for bulk add, task chips, score sliders, priorities, save and
  discard, retained invalid edits across tabs, failure recovery, and provider
  selection. Use isolated network fixtures instead of writing live config.
- Check desktop and narrow layouts, English LTR/RTL, keyboard navigation, and
  mixed-direction model labels.
- Run `bun typecheck` from `packages/app` and focused package tests.

All new visible text goes through typed i18n. Use existing design tokens and
logical CSS. Do not restart the running app/server.
