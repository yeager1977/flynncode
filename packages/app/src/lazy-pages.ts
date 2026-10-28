import { lazy } from "solid-js"

// Pages outside the default start path load on first use, so they stay out of the startup bundle. The new layout
// is the default; the legacy layout and its home page are only needed when it is turned off.
export const LegacyLayout = lazy(() => import("@/pages/layout"))
export const LegacyHome = lazy(() =>
  import("@/pages/home/legacy-home").then((module) => ({ default: module.LegacyHome })),
)
export const UsagePage = lazy(() => import("@/pages/usage").then((module) => ({ default: module.UsagePage })))
export const CleanupPage = lazy(() => import("@/pages/cleanup").then((module) => ({ default: module.CleanupPage })))
