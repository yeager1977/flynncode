# Session Task Chips — Design

Date: 2026-09-29
Status: Approved — subtle inset surface

## Problem

The individual todo rows in `SessionTodoDock` visually blend into the dock's
outer layer-01 container. The outer dock already has a border and background,
but each task row is currently rendered without its own surface boundary.

## Design

Give each task row a compact, low-contrast inset surface using existing app
design tokens: layer-02 background, a hairline border, small corner radius, and
consistent inline/block padding. Keep the outer dock surface unchanged. Preserve
the in-progress accent rail, completed/cancelled strikethrough and muted text,
pending opacity, detail expansion, and existing keyboard behavior. Use symmetric
inline spacing for the chip so it remains direction-neutral in RTL.

### Alternatives considered

- Outline-only rows: less surface change, but insufficient separation from the
  dock's existing outline.
- Status-tinted fills: most visible, but introduces more color and visual noise
  than the current restrained session composer needs.

## Scope

- Target: task rows inside `packages/app/src/pages/session/composer/session-todo-dock.tsx`.
- No changes to the outer dock, task behavior, content parsing, localization, or
  other composer docks.
- Preserve the existing uncommitted task-detail/summary work in the component.

## Verification

- Run the focused `SessionTodoDock` source-contract test and relevant app checks.
- Render the expanded task dock in a browser at narrow and desktop widths, with
  pending, active, and completed tasks, and verify the chip surface reads as a
  distinct inset level without clipping or changing interaction behavior.
- Check LTR and RTL direction; all new spacing remains symmetric/logical.
