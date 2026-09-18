# Model Router: All Models + Per-Task Selection - Design

Date: 2026-09-17
Status: Approved

## Problem

The router surfaced only a couple of models and gave no way to choose a
specific model per purpose:

1. Models without a scorecard entry were excluded because `allowUnscored`
   defaulted to `false`. A user with 24 provider models and 3 scorecard entries
   saw exactly 3 eligible models, and tasks could have zero (e.g. `writing`).
2. The only routing lever was `tags`, which restricts the automatic pool; it
   cannot assign a chosen model to a task.

## Goal

- Every model on a configured provider is eligible by default.
- A task can be pinned to a specific model, overriding scoring and tags.
- The settings editor exposes both: a per-task model picker on Routing and the
  full catalog of available models on Models.

## Plugin Changes

- `allowUnscored` default flips to `true`. Unscored models score neutral
  5/5/5. Setting it to `false` restores the previous strict behavior.
- New `taskModels: Record<TaskName, "providerID/modelID">` option:
  - `parseOptions` validates task names and model keys.
  - `rankModels` gains `opts.pinned`. A pinned candidate is ranked first and
    bypasses tag filtering and unscored exclusion. Its provider being disabled
    still excludes it, and the pin is then ignored.
  - `assignAgents` and both tools pass `options.taskModels[task]`.
- The existing `models` scorecard still refines non-pinned ranking.

## Settings Editor Changes

- Payload mirrors the plugin: `taskModels` on the form, default
  `allowUnscored: true`, validation for pinned keys. Absent `taskModels` is
  omitted from the serialized payload.
- Routing tab: each task card gains a "Model for …" select listing available
  models plus an "Automatic (best match)" option.
- Models tab: an "Available models" section lists every in-scope model not yet
  scored, one click from adding it at neutral scores.

## Verification

- Plugin tests cover the new default, `taskModels` parsing, pin precedence
  (beats higher score, overrides tags and unscored exclusion, ignored when the
  provider is disabled), and config-hook assignment.
- App payload and preview tests mirror the plugin contract.
- `bun typecheck` in `packages/opencode`; app unit tests, app typecheck, and
  e2e typecheck.

## Out of Scope

- Live re-routing without restart.
- Automatic price or benchmark discovery.
- Changes to scoring weights or tie-break order.
