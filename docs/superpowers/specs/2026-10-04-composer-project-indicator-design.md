# Composer project indicator — design

Date: 2026-10-04
Status: approved

## Problem

The composer bottom bar shows agent, model, variant, and accept-all controls, but never
shows which project the session belongs to. With many sessions open across projects, the
user has no orientation at the point of typing.

## Goal

Show a project indicator in the composer's bottom bar to the left of the model selector.
Clicking it opens a small read-only popover with the project's avatar, name, worktree
path, and session count.

## Non-goals

- No editing (rename, avatar) from this popover — the existing project edit dialogs stay
  the canonical editors.
- No project/directory switching from this popover.
- No changes to the mobile layout beyond inheriting whatever the control row does today.

## Approach

Follow the established `modelControl` slot pattern: session-ui's `PromptInputV2` exposes a
generic slot; the app supplies app-level content.

### session-ui (`packages/session-ui/src/v2/components/prompt-input/index.tsx`)

- `PromptInputV2Props` gains `projectControl?: JSX.Element`.
- Render it as the first child of the left control group (before `PromptInputV2AddMenu`),
  so the row reads: project · add-menu · agent · model · variant · accept-all.

### App (`packages/app/src/components/prompt-input-v2.tsx`)

- New `PromptInputV2ProjectControl` component, rendered into the new slot when a project
  resolves for the current directory.
- Button styling matches the model control: `ButtonV2` variant `ghost-muted`, height 28,
  `![font-weight:440]`, `min-w-0 max-w-[220px] justify-start`, truncated label, chevron.
- Content: `ProjectAvatar` (from `@opencode-ai/ui/v2/project-avatar-v2`, size-4) + project
  name + chevron.
- Click opens a read-only popover (`@opencode-ai/ui/popover`) containing:
  - header: avatar + name
  - worktree path row (monospace, selectable copy behavior unchanged — display only)
  - session count row
- Tooltip (`TooltipV2`, placement top) labels the button with the project name.

### Data sources (all verified)

- Project resolution: `layout.projects.list().find((p) => p.worktree === directory ||
  p.sandboxes?.includes(directory))` — same lookup `session-header.tsx` uses, keyed on the
  route directory.
- Name: `project.name || getFilename(project.worktree)`; when no project matches, derive
  from the directory's basename (same as session-header's fallback) — but the control only
  renders when a project object exists, so the fallback name path is not user-visible here.
- Avatar: `ProjectAvatar` with the project avatar variant from the layout store's avatar
  color assignment (same as home projects view).
- Session count: sessions sync store filtered to `worktree` + `sandboxes` of the project,
  counting non-archived sessions.

### Visibility rules

- Render only when a project resolves for the route directory AND `ProjectAvatar`/name
  data is present.
- Hidden on the unpaid/model-loading states? No — project visibility is independent of
  model state; it renders whenever resolvable.

### i18n

- New keys (en + fallback spread into all locales, same pattern as
  `session-review-fallback.ts`):
  - `session.project.path` — label for the worktree row
  - `session.project.sessions` — label for the session-count row
  - `session.project.open` — button tooltip ("Project")
- No locale machinery changes; ordinary `language.t` usage.

### RTL

The control sits in the normal flex flow (logical order); no physical margins. Popover
placement via existing `Popover` handles direction.

### Error handling

- If the projects list has not loaded, the control renders nothing (no spinner, no
  layout shift once it appears — it animates in like the model control).
- If the session-count query is unavailable in a legacy sync shape, omit the count row
  rather than showing 0.

## Testing

- Unit: extend `session-composer-state.test.ts`-style patterns — assert the control
  renders with resolved project name, is absent without a resolvable project, and the
  popover rows display path and count.
- Keep the existing source-contracts in `prompt-input-v2` tests intact; add the new
  control's contract assertions to the existing test file that pins component wiring.
- e2e: optional follow-up; not required for this change (existing suites cover the
  composer region).

## Files touched

- `packages/session-ui/src/v2/components/prompt-input/index.tsx` (slot + render)
- `packages/app/src/components/prompt-input-v2.tsx` (control component, slot wiring)
- `packages/app/src/pages/new-session/new-session-view.tsx` (pass project control when a
  project is known)
- `packages/app/src/i18n/en.ts` + fallback file + (fallback spread covers locales)
- app i18n fallback file for pending translations
- tests near the touched components