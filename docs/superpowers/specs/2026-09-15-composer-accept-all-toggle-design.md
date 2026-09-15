# Composer Accept-All Toggle — Design

Date: 2026-09-15
Status: Approved

## Problem

Accept-all (auto-accept permissions) is only reachable from Settings. The chat
page has no control. Settings currently edits whichever scope matches the route
(session override or project default), which makes the two scopes easy to
confuse.

## Goal

An Accept-All toggle in the prompt composer toolbar on every chat page, with
Settings reduced to the project default and the composer toggle providing a
per-session override.

## Behavior

- Session exists: the composer toggle writes a per-session override.
- No session (new-session page): the composer toggle edits the project default.
- Settings: always edits the project default, never a session override.
- Precedence (existing, unchanged): session lineage override > project default >
  require approval.

## Implementation

### Composer toolbar

- Classic composer (`packages/app/src/components/prompt-input.tsx`): a new
  sibling control in the `DockTray attach="top"` toolbar after the variant
  control, `data-component="prompt-accept-all-control"`,
  `data-action="prompt-accept-all"`.
- V2 composer: pass the same control from the app wrapper
  (`packages/app/src/components/prompt-input-v2.tsx`) via a new
  `acceptAllControl` slot prop on `PromptInputV2`, rendered in its toolbar.
- Control: `IconButtonV2` pattern with `aria-pressed`, `aria-label`, and a
  tooltip carrying the existing keybind (`permissions.autoaccept`,
  mod+shift+a). Icon: existing `checklist` (classic registry). Active state
  styled distinctly.
- Click calls the existing permission context:
  session → `toggleAutoAccept(sessionID, directory)`;
  no session → `toggleAutoAcceptDirectory(directory)`.
- Tooltip text distinguishes scope: "Override for this session" when a session
  exists and a project default is active, otherwise the existing
  enable/disable strings.

### Settings default-only

- Classic settings (`packages/app/src/components/settings-general.tsx`): the
  Accept-All switch always reads/writes the directory default
  (`isAutoAcceptingDirectory` / `toggleAutoAcceptDirectory`), sourced from
  `useServerSDK().directory` (works on both route layouts, replacing
  `decode64(params.dir)` which is undefined on the new layout).
- V2 settings (`packages/app/src/components/settings-v2/general-controllers.ts`
  `createPermissionScopeController` → new directory-scoped controller): the
  switch edits the project default for the active directory.
- The session-override writer (`enableAutoAccept`/`disableAutoAccept`) remains
  used by the composer and by new-session submit, but no longer by Settings.

### Tests

- Pure helper `toggleTarget(sessionID | undefined)` returning
  `"session" | "directory"` — tested.
- Precedence tests already exist in
  `packages/app/src/context/permission-auto-respond.test.ts`; add:
  cross-directory key isolation, and the effective-state toggle semantics
  (toggling off an inherited true writes an explicit session false).

## Out of scope

- No changes to permission response handling or the permission dock.
- No new permission levels or config keys.
