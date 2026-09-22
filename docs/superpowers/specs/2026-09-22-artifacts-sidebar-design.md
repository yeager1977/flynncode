# Artifacts Sidebar - Design

Date: 2026-09-22
Status: Draft

## Problem

Sessions produce work the user wants to find later: changed files, generated
files, diffs, notes. Today the desktop sidebar shows projects and sessions
only. Artifacts have no surface.

## Goal

A desktop sidebar that lists session artifacts and opens them.

## Scope

In scope:

- A sidebar section for the active project: changed files (from
  `session.diff` events, already streamed to the app store as
  `session_diff`), grouped by session, newest first.
- Clicking an artifact opens the session and scrolls to the file's diff.
- Refresh on `session.diff` events (already in the global-sync reducer).
- English copy via i18n keys; no hardcoded English.
- e2e regression test for projection and navigation.

Out of scope:

- Non-project artifacts (screenshots, exported notes) in cycle 3.
- Mobile.

## Approach

- `packages/app/src/pages/layout/sidebar-artifacts.tsx`: component listing
  artifacts from the existing `session_diff` store slice, for the active
  project's sessions, grouped by session, top 20 newest.
- Mount it in the sidebar under the project sessions section; collapsed by
  default with a header toggle.
- Reuse existing sidebar styling (bg, text sizes, hover states); no new CSS
  file. RTL-safe: logical spacing only.
- Clicking navigates with the existing session route (`/:dir/session/:id`);
  no new routing.

## Data

- Source: `useServerSync().data` session_diff slice, already populated by the
  `session.diff` event reducer (packages/app/src/context/global-sync/event-reducer.ts:256).
- Project attribution via the session's directory, same as other sidebar code.

## Testing

- Unit: grouping and ordering helper (new file `sidebar-artifacts.ts` for the
  pure part) - newest session first, max 20, empty state.
- e2e: a session with a diff event renders an artifact row; clicking it
  navigates to the session.