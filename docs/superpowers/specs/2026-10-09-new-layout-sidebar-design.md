# New-layout Project Sidebar - Design

Date: 2026-10-09
Status: Approved in conversation

## Problem

Upstream retired the classic layout (`oldInterfaceSunset`), so only the new
layout renders, and it has no project/session list. Flynncode users lost the
left sidebar (projects, sessions, workspaces, artifacts, bulk cleanup) and the
desktop menu's Toggle Sidebar / Next-Previous Project / Next-Previous Session
items do nothing.

## Decisions (from user)

- Add a collapsible left sidebar to the new layout (not restore the classic
  layout).
- Open (expanded) by default on first run; collapsed state is an icon rail.
- Reuse the classic sidebar's working pieces instead of new UI.

## Design

- Placement: in `layout-new.tsx`, below the Titlebar, a row of
  [sidebar | main]. Expanded: project list (drag reorder, open project),
  per-project sessions and workspaces, artifacts section, bulk
  select/cleanup — the classic `SidebarContent`, `SortableProject`,
  `sidebar-workspace`, `sidebar-artifacts-section` components. Collapsed: a
  narrow icon rail of projects. Width resizable and persisted via the existing
  `layout.sidebar` store.
- Toggle: a sidebar icon button in the Titlebar and `mod+b`
  (`layout.sidebar.toggle`). Register the classic commands the new layout
  lacks: `sidebar.toggle`, `project.previous/next`, `project.1-9` (mod+1-9),
  `session.previous/next` and unseen variants, so the desktop menu items work.
  Keybinds must not collide with existing new-layout bindings.
- Behaviour: selecting a session opens it as a tab (new-layout tabs);
  selecting a project opens a new draft for it. Inbox stays in the Titlebar;
  Settings stays where it is.
- Structure: extract the classic layout's sidebar state and handlers out of
  `pages/layout.tsx` into a shared hook/module used by both layouts; the
  classic layout must keep working unchanged.
- Styling: v2 components and tokens matching the new layout; no unstyled
  markup.

## Testing

Controller/hook logic tested with real Solid effects in `test-browser`;
typecheck; existing layout/home/session tests stay green; manual check in the
running app.
