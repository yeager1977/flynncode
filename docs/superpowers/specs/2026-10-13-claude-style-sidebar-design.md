# Claude-style sidebar navigation

Date: 2026-10-13
Status: approved in chat, pending spec review

## Problem

In the new layout (forced on since the classic layout's 2026-09-14 sunset), clicking a
session in the left sidebar navigates to `/server/:serverKey/session/:id`, and two route
effects append that session to a persisted tab list rendered as a horizontal strip in the
titlebar (`TitlebarTabStrip`). Every sidebar click grows the strip. The sidebar itself is a
project-avatar rail plus a per-project session panel with hover peeks.

The owner wants the Claude Code / Codex desktop model: the left sidebar *is* the session
navigation, as one simple column, and no tab strip.

Separately, the model selector button is missing from the new-session composer in the
packaged desktop app. That fix ships in the same build but is tracked by its own root-cause
investigation, not this spec.

## Design

### Layout

One column replaces the rail and merged panel (`ProjectSidebar` in
`packages/app/src/pages/layout-new-sidebar.tsx`):

- Top: **New session** (opens a draft for the current project; the draft page's project
  chooser already lets the user switch) and **Search sessions** (existing session search).
- Middle, scrollable: every open project (`layout.projects.list()`, existing drag order) as a
  collapsible header showing its name, with a hover "+" that starts a draft in that project.
  Under it, that project's root sessions newest first, using the existing per-project
  page size and "Load more" control. Collapsed state reuses the persisted
  `LocalProject.expanded` flag.
- Session rows reuse `SessionItem` (`pages/layout/sidebar-items.tsx`), keeping status and
  unread indicators and the rename/archive menu. The routed session is highlighted.
- Bottom: **Add project** and **Settings**.
- The sidebar toggle hides the whole column. The rail, hover peek and avatar overlays are
  not mounted.
- The phone drawer renders the same column.

### Navigation

- A session row is a link to `sessionHref(server.key, id)`; the route drives the main view.
- Remove the auto-add-tab effects: `ResolvedTargetSessionRoute` in `pages/session.tsx` and
  the titlebar effect in `components/titlebar.tsx` that adds the current route as a tab.
- Do not mount `TitlebarTabStrip`. (The phone "session / changes" tabs in `pages/session.tsx`
  switch panes within one session, not sessions, and stay.)
- Drafts keep their hidden `DraftTab` entries, because `DraftRoute` in `app.tsx` redirects to
  `/` when `?draftId` is not in `tabs.store`. "New session" creates or reuses a draft tab
  exactly as today (`projectDraft`), it is just never displayed.
- `openSession` / `openProject` on the sidebar host navigate directly instead of calling
  `tabs.addSessionTab` / `tabs.replaceTab`.
- Keybinds: Mod+1-9 open the 1st-9th visible session in sidebar order (previously tab
  index). Alt+Up/Down session cycling is unchanged.

### Out of scope

- Classic layout, project drag-reorder internals, worktree/workspace menus, artifacts
  section, sync/phone features: unchanged.
- Old components (`TitlebarTabStrip`, rail, peek) stay in the tree but unmounted, to keep
  upstream merges small. No deletion in this change.

## Units

- `visibleSessionOrder(groups)`: pure function giving the flat visible-session order used
  by Mod+1-9. Lives in `pages/layout/new-layout-sidebar.ts`.
- `SessionSidebar` component: renders the column from that model, reusing `SessionItem`
  via `LocalWorkspace` in a new non-scrolling `inline` mode.
- Route/titlebar edits: remove the two tab-adding effects and the strip mount.

## Testing

- Unit: the visible-session order behind Mod+N (expanded projects only, in order).
- Manual in the built app: visiting sessions leaves no tabs; Mod+N jumps.
- Existing `packages/app` unit suite and typecheck pass.
- Build the deb; owner verifies in the desktop app.
