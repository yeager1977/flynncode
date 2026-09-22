# Routines - Design

Date: 2026-09-22
Status: Draft

## Problem

Users repeat the same agent prompts daily (morning triage, release checks,
dependency sweep). Today each run needs manual prompting.

## Goal

A Routines menu in the desktop app: create, run, and manage repeatable agent
jobs. A routine is a named prompt with a trigger (manual, daily, weekly) and
an optional target project.

## Scope

In scope:

- `~/.config/opencode/routines.jsonc`: user file, JSONC, schema
  `{ routines: [{ id, name, prompt, schedule?, enabled }] }`.
  `schedule` is cron-like: `{ dailyAt?: "HH:MM" }` only for cycle 1 (no full
  cron parser; manual + daily-at only).
- Desktop menu entry (sidebar rail section or settings page) listing
  routines with Run now / toggle / delete.
- A server-side scheduler in the built-in Flynncode plugin that:
  - loads routines from the user config file at startup,
  - runs due routines by prompting a new session via the SDK,
  - records last run in the file.
- English copy via i18n keys.
- Unit tests for parsing and the due-check; plugin test for scheduling.

Out of scope:

- Full cron, per-project routing, webhooks, run history UI beyond a simple
  "last run" timestamp, notifications.

## Approach

- `packages/opencode/src/plugin/routines/` (built-in Flynncode plugin):
  `parse.ts` (validate + defaults), `scheduler.ts` (interval tick, due
  check, session spawn via SDK client), `index.ts` (plugin hooks).
- App: settings-v2 `routines.tsx` page reusing SettingsRowV2 list patterns;
  nav item "Routines" in settings tab list.
- The scheduler runs only while OpenCode runs; missed schedules while the
  app was closed are skipped (documented behavior).
- Enable/disable per routine; disabled routines never run.

## Testing

- `parse.test.ts`: valid/invalid routines, defaults.
- `scheduler.test.ts`: due at HH:MM once per day, skip when disabled, no
  double-run within the same minute.
- App: payload round-trip test.