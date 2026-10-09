import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage, type Locale } from "@/context/language"
import { showToast } from "@/utils/toast"

const COLOR_SCHEMES: ColorScheme[] = ["system", "light", "dark"]
const COLOR_SCHEME_KEYS = {
  system: "theme.scheme.system",
  light: "theme.scheme.light",
  dark: "theme.scheme.dark",
} as const satisfies Record<ColorScheme, string>

// Palette commands the legacy layout registered globally and the new layout
// was missing: theme, color scheme and language switching plus the provider
// and server dialogs. Their legacy keybinds (mod+shift+t / mod+shift+s) now
// belong to "reopen closed tab" and "new session", so these stay palette-only.
export function LayoutCommands() {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const theme = useTheme()

  const cycle = <T,>(list: readonly T[], current: T) => list[(list.indexOf(current) + 1) % list.length]
  const schemeLabel = (scheme: ColorScheme) => language.t(COLOR_SCHEME_KEYS[scheme])
  const setLocale = (next: Locale) => {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  command.register("layout", (): CommandOption[] => [
    {
      id: "provider.connect",
      title: language.t("command.provider.connect"),
      category: language.t("command.category.provider"),
      onSelect: () => {
        void import("@/components/dialog-connect-provider").then((module) =>
          dialog.show(() => <module.DialogConnectProvider />),
        )
      },
    },
    {
      id: "server.switch",
      title: language.t("command.server.switch"),
      category: language.t("command.category.server"),
      onSelect: () => {
        void import("@/components/dialog-select-server").then((module) =>
          dialog.show(() => <module.DialogSelectServer />),
        )
      },
    },
    {
      id: "theme.cycle",
      title: language.t("command.theme.cycle"),
      category: language.t("command.category.theme"),
      onSelect: () => {
        const ids = theme.ids()
        if (ids.length === 0) return
        const next = cycle(ids, theme.themeId())
        theme.setTheme(next)
        showToast({ title: language.t("toast.theme.title"), description: theme.name(next) })
      },
    },
    ...theme.ids().map((id) => ({
      id: `theme.set.${id}`,
      title: language.t("command.theme.set", { theme: theme.name(id) }),
      category: language.t("command.category.theme"),
      onSelect: () => theme.commitPreview(),
      onHighlight: () => {
        theme.previewTheme(id)
        return () => theme.cancelPreview()
      },
    })),
    {
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      onSelect: () => {
        const next = cycle(COLOR_SCHEMES, theme.colorScheme())
        theme.setColorScheme(next)
        showToast({ title: language.t("toast.scheme.title"), description: schemeLabel(next) })
      },
    },
    ...COLOR_SCHEMES.map((scheme) => ({
      id: `theme.scheme.${scheme}`,
      title: language.t("command.theme.scheme.set", { scheme: schemeLabel(scheme) }),
      category: language.t("command.category.theme"),
      onSelect: () => theme.commitPreview(),
      onHighlight: () => {
        theme.previewColorScheme(scheme)
        return () => theme.cancelPreview()
      },
    })),
    {
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => setLocale(cycle(language.locales, language.locale())),
    },
    ...language.locales.map((locale) => ({
      id: `language.set.${locale}`,
      title: language.t("command.language.set", { language: language.label(locale) }),
      category: language.t("command.category.language"),
      onSelect: () => setLocale(locale),
    })),
  ])

  return null
}
