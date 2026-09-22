# Dispatch - Design

Date: 2026-09-22
Status: Draft

## Problem

Claude Desktop-style dispatch: hand the agent a task without typing into the
session - a quick "send a task" surface with status at a glance.

## Goal

A Dispatch panel in the desktop app: type a task, pick project/agent/model,
send it as a new session, see running/recent dispatched tasks.

## Scope

In scope:

- New sidebar rail action (plus-key adjacent) opening a Dispatch overlay:
  textarea, target selector (directory + agent), submit.
- Submit calls the existing prompt API: create session, then
  `session.prompt` with the text (fire-and-forget with optimistic UI).
- Running list: sessions started from Dispatch, tracked in a local store
  (session id + title + status from the existing event stream).
- English copy via i18n.
- e2e smoke: open panel, send task, session appears in list.

Out of scope:

- Scheduling (Routines covers that), attachments, multi-target broadcast,
  notification integration (exists via session notifications).

## Approach

- `packages/app/src/pages/dispatch/dispatch-store.ts`: local store
  (createSignal store) of dispatched tasks keyed by sessionID.
- `packages/app/src/pages/dispatch/dispatch-panel.tsx`: overlay panel
  (existing modal/overlay primitives), composer reusing the existing
  prompt-send path used by new-session.
- Sidebar: one IconButton in the rail next to settings.
- Reuse `useServerSync` for `session.create` / prompt send and event
  subscription for status; no new server code.

## Testing

- Unit: dispatch store add/update/complete transitions.
- e2e smoke: open, submit, session listed.