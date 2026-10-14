import { dict } from "./en"
import { desktopNativePluralCategories, type DesktopNativeLocale } from "./desktop-native"

// Hooks translations are pending. Locale entries override this explicit
// English fallback as verified translations become available. Plural
// categories beyond one/other reuse the English "other" form until then,
// for every Flynncode plural family awaiting translation.
const pendingPlurals = ["settings.hooks.pending", "sidebar.sessions.showMore"] as const

export function hooksFallback(locale: DesktopNativeLocale) {
  return {
    ...Object.fromEntries(
      Object.entries(dict).filter(([key]) => key.startsWith("settings.hooks.") || key === "settings.tab.hooks"),
    ),
    ...Object.fromEntries(
      desktopNativePluralCategories(locale)
        .filter((category) => category !== "one" && category !== "other")
        .flatMap((category) => pendingPlurals.map((key) => [`${key}.${category}`, dict[`${key}.other`]])),
    ),
  }
}
