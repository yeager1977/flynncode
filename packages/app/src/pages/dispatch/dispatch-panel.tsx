import { ActivityInboxPanel } from "./activity-inbox"

// The dispatch entry point keeps its name so the lazy import in layout.tsx
// keeps working; all list rendering lives in ActivityInboxPanel.
export function DispatchPanel() {
  return <ActivityInboxPanel />
}
