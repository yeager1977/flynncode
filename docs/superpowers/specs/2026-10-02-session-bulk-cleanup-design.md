# Session bulk cleanup

Date: 2026-10-02
Status: Draft — awaiting review
Product: Flynncode desktop, not upstream OpenCode

## Decision

Add select mode and a Clean up menu to the project sidebar session list and the home session list. Both can archive or permanently delete. Age cleanup uses last updated. Open and running sessions are skipped.

## What already exists

- The sidebar archives one root session on hover (`packages/app/src/pages/layout/sidebar-items.tsx`). That button stays.
- Home has a per-row archive button behind `SHOW_HOME_SESSION_ARCHIVE = false`. Leave it hidden.
- Archive is `session.update` with `time.archived`. Delete is `session.remove`, which already deletes child sessions.
- The sidebar window is trimmed. `listAllSessions` already loads every session for a directory. The home index already loads every session for the server.
- Visible lists hide archived sessions and do not list child sessions as roots.

## Interaction

Each list header gets Select and Clean up. The sidebar puts them on the workspace or local-project header that owns that list. Home puts them beside New session.

Select shows checkboxes on root rows only. A click toggles selection and does not open the session. Shift-click selects the loaded range, skipping protected rows. The bar shows the count, Select all loaded, Archive, Delete, and Cancel. Escape or Cancel clears the selection and exits. Select all covers loaded, unprotected root rows only. It does not load more rows.

Open sessions, sessions open in a tab, running sessions, and sessions waiting on a permission or question are not selectable. A root is also locked when any child is protected. Locked rows show a disabled checkbox.

Archive and Delete both confirm first. Delete says it cannot be undone and that child sessions go with the parent. Archive says the sessions will be hidden. Success exits select mode.

Clean up is a menu: 1 week, 2 weeks, 1 month, 3 months, 6 months, 1 year. Choosing a preset opens a confirm. The confirm shows how many sessions match and how many were skipped because they are open or running. It offers Archive and Delete. Zero matches shows that and offers no action.

Opening home search, collapsing the workspace, or switching projects clears select mode. Clean up ignores the home search query.

## Scope

The control acts on the directory of the list it was opened from. A workspace header does not include sibling workspaces. Home includes every root session on that server.

Select uses rows already loaded in that list. Clean up does not. Sidebar Clean up calls `listAllSessions` for that directory. Home Clean up uses the home session index.

Only unarchived root sessions are eligible. Child sessions are not selected on their own. Deleting a root still removes its children through `session.remove`. Archiving a root hides it, and the lists already hide its children.

## Eligibility

Rules live in one pure module, `packages/app/src/pages/session/session-bulk.ts`. Both lists call it.

Age uses `time.updated`, then `time.created` when updated is missing. Durations are fixed day counts, not calendar months:

- 1 week: 7 days
- 2 weeks: 14 days
- 1 month: 30 days
- 3 months: 90 days
- 6 months: 180 days
- 1 year: 365 days

A session is older only when its timestamp is strictly before `now - duration`. A session updated at the exact cutoff stays.

`now` is fixed when the confirm opens. The candidate list is frozen then. Sessions that appear later are not added. Sessions that disappear, or that become protected before their call, are dropped.

Protected means any of:

- the session is the open route
- the session is open in a tab
- `session_working` is true
- the session has a pending permission or question
- a child of that root is protected

## Actions

A runner takes the frozen root ids and an archive or delete operation. It does not check the v1 protocol gate used by the old one-session archive.

Archive calls `session.update` with `time.archived` on v1 and v2. Delete calls `session.remove` once per root, not once per child.

Calls run one at a time. After each success, drop that session from the sidebar store and the home index. The open route and open tabs are protected, so a normal batch does not change the current view. If a removed session still has a tab, close that tab. If a race removes the current route, use the existing single-delete navigation.

Archive and Delete stay disabled while a batch runs.

## Errors

A failed directory or home load does not open a confirm. It shows the existing request-failed toast and stops.

Nothing is sent before confirm. Each id is checked again immediately before its call. A session that became protected is skipped and counted with the other skips. It is not sent.

If a call fails, earlier successes stay removed. The runner does not continue. The toast says the batch stopped and how many sessions were not changed. Select mode stays open with the failed id and the not-yet-attempted ids still selected. If every call succeeds, select mode closes.

Delete cannot be undone. This feature does not add restore for archived sessions.

## Copy

Add English keys to `packages/app/src/i18n/en.ts`. Do not invent translations. Other locales already fall back to English.

Visible strings, placeholders, and accessible labels go through `language.t(...)`. Counts use `language.plural(...)`. English source:

- Select
- Clean up
- Archive
- Delete
- Cancel
- Select all loaded
- Delete {{count}} sessions? This cannot be undone. Child sessions are deleted too.
- Archive {{count}} sessions? They will be hidden.
- {{count}} sessions not updated in {{period}}. {{skipped}} skipped because they are open or running.
- No sessions are old enough.
- Could not finish. {{count}} sessions were not changed.

## Tests

Test the pure module and the runner from `packages/app`. Do not add an end-to-end test in this pass.

Eligibility tests cover each preset boundary, an exact cutoff that stays, a missing `time.updated`, an open route, an open tab, a running session, a permission wait, a question wait, a protected child locking its root, an archived session, and a child session.

The runner test uses a fake client that records calls. One failure mid-batch keeps earlier successes, returns the failed ids, and does not continue. Archive sends `time.archived` with no v1 check. Delete calls `session.remove` once per root.

## Out of scope

- The TUI session picker.
- A restore or unarchive view.
- A per-row archive button on home.
- Removing the sidebar hover archive.
- Selecting child sessions on their own.
- Loading every sidebar row when Select all is pressed.
- Cleaning up sibling workspaces from one workspace header.
