# Composer Permission Switch

Date: 2026-09-16

## Problem

The composer permission button uses the same checklist icon in both states,
with a subtle pressed background as its only persistent visual distinction.
An accidental click can disable a chat's auto-accept override while Settings
continues to show the enabled project default.

## Approved direction

Replace the icon-only control in both classic and V2 composers with the existing
V2 `Switch` component and a visible **Auto-accept permissions** label. The user
selected the labeled switch over a stronger icon-only indicator and declined a
browser mockup.

## Behavior and implementation

- Bind `checked` to the existing effective `accepting()`/`active()` accessor so
  inherited project defaults and explicit chat overrides are shown accurately.
- Reuse the existing translated `command.permissions.autoaccept.enable` label.
  Keep the label stable; the switch track and thumb communicate the current state.
- Use the shared switch's filled accent track when checked and neutral track
  when unchecked, including its existing keyboard, focus, and RTL behavior.
- Keep the existing scope-aware tooltip and keyboard shortcut.
- Preserve the existing session/directory toggle callbacks and permission
  precedence: chat lineage override, then project default, then require approval.
- Keep `data-action="prompt-accept-all"` as the control's automation hook.
- Keep the control compact and readable in the composer toolbar at narrow widths.
- Pass the stable translated label through the existing V2 view configuration;
  permission state continues to be owned by the app's permission context.

The affected implementation is in the two app composer wrappers and the V2
session-ui composer. The shared switch already supplies the required visual and
interaction behavior. This presentation change adds no network calls, persisted
state, or error paths.

## Verification

- Record and compare a production session benchmark around the composer change.
- Check both switch states, inherited-on and explicit-off behavior, pointer and
  keyboard toggling, and the existing shortcut.
- Check classic and V2 layouts, light/dark themes, narrow widths, English LTR,
  forced RTL, and an existing RTL translation.
- Run the existing permission and prompt-input checks plus typechecks in the
  affected package directories. This low-impact presentation change reuses the
  existing switch rather than introducing new control logic or matching unit tests.
