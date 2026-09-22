import { useLanguage } from "@/context/language"

const PATH = "~/.config/opencode/routines.jsonc"

export function SettingsRoutinesV2() {
  const language = useLanguage()
  return (
    <div class="settings-v2-tab-body flex flex-col gap-3 p-4">
      <h2 class="settings-v2-tab-title">{language.t("settings.routines.title")}</h2>
      <p class="text-text-weak">{language.t("settings.routines.description")}</p>
      <p class="text-14-regular" dir="ltr">
        {PATH}
      </p>
      <pre class="overflow-auto rounded bg-surface-raised-base p-3 text-12-regular" dir="ltr">
        {language.t("settings.routines.example")}
      </pre>
    </div>
  )
}
