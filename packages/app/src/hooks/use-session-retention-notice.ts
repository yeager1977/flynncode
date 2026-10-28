import { createEffect, createSignal, type Accessor } from "solid-js"
import type { SessionRetention } from "@flynncode/sdk/v2/client"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { firstRunNotice, markNoticeShown, noticeShown } from "@/utils/session-retention"
import { showToast } from "@/utils/toast"

// Tells the owner once per delayed cleanup, in this app profile, that it is pending.
export function useSessionRetentionNotice(retention: Accessor<SessionRetention | undefined>) {
  const language = useLanguage()
  const openSettings = useSettingsDialog("general")
  // Also guards this run when storage is blocked and nothing can be remembered.
  const [shown, setShown] = createSignal(noticeShown())

  createEffect(() => {
    const notice = firstRunNotice(retention(), shown())
    if (!notice) return
    setShown(notice.firstRunAt)
    markNoticeShown(notice.firstRunAt)
    showToast({
      title: language.t("session.retention.notice.title"),
      description: language.t("session.retention.notice.description", {
        count: notice.count,
        days: notice.days,
        when: new Intl.DateTimeFormat(language.locale(), { dateStyle: "medium", timeStyle: "short" }).format(
          notice.firstRunAt,
        ),
      }),
      persistent: true,
      actions: [
        { label: language.t("session.retention.notice.action"), onClick: openSettings },
        { label: language.t("common.dismiss"), onClick: "dismiss" },
      ],
    })
  })
}
