import { getFilename } from "@flynncode/core/util/path"
import { useNavigate } from "@solidjs/router"
import { createEffect, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { sessionHref } from "@/utils/session-route"
import { playSoundById } from "@/utils/sound"
import { dismissToast, showToast } from "@/utils/toast"
import { Worktree } from "@/utils/worktree"

const ALERT_COOLDOWN_MS = 5000

// Server events the legacy layout handled and the new layout needs too:
// worktree readiness unblocks prompts queued for a freshly created worktree
// (otherwise they wait out the five-minute timeout), and permission/question
// requests honour the notification and sound settings and raise a toast for
// sessions the user is not looking at.
export function LayoutEvents() {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const language = useLanguage()
  const settings = useSettings()
  const platform = usePlatform()
  const permission = usePermission()
  const layout = useLayout()
  const navigate = useNavigate()
  const toasts = new Map<string, number>()
  const alerted = new Map<string, number>()

  const dismiss = (sessionID: string) => {
    const toast = toasts.get(sessionID)
    if (toast === undefined) return
    dismissToast(toast)
    toasts.delete(sessionID)
    alerted.delete(sessionID)
  }
  const viewing = () => {
    const route = layout.route()
    return route.type === "session" ? route.sessionId : undefined
  }

  createEffect(() => {
    const sdk = serverSDK()
    const unsubscribe = sdk.event.listen((event) => {
      const details = event.details
      if (details?.type === "worktree.ready") {
        Worktree.ready(sdk.scope, event.name)
        return
      }
      if (details?.type === "worktree.failed") {
        Worktree.failed(sdk.scope, event.name, details.properties?.message ?? language.t("common.requestFailed"))
        return
      }
      if (details?.type === "question.replied" || details?.type === "question.rejected" || details?.type === "permission.replied") {
        dismiss(details.properties.sessionID)
        return
      }
      if (details?.type !== "permission.asked" && details?.type !== "question.asked") return
      const asked = details.type === "permission.asked"
      if (details.type === "permission.asked" && permission.autoResponds(details.properties, event.name)) return

      const sessionID = details.properties.sessionID
      const session = serverSync().session.peek(sessionID)
      const now = Date.now()
      if (now - (alerted.get(sessionID) ?? 0) < ALERT_COOLDOWN_MS) return
      alerted.set(sessionID, now)

      const title = language.t(asked ? "notification.permission.title" : "notification.question.title")
      const copy = {
        sessionTitle: session?.title ?? language.t("command.session.new"),
        projectName: getFilename(event.name),
      }
      const description = language.t(
        asked ? "notification.permission.description" : "notification.question.description",
        copy,
      )
      const href = sessionHref(ServerConnection.key(sdk.server), sessionID)
      if (asked && settings.sounds.permissionsEnabled()) void playSoundById(settings.sounds.permissions())
      if (asked ? settings.notifications.permissions() : settings.notifications.agent())
        void platform.notify(title, description, () => navigate(href))

      const current = viewing()
      if (current === sessionID || (current && session?.parentID === current)) return
      dismiss(sessionID)
      alerted.set(sessionID, now)
      toasts.set(
        sessionID,
        showToast({
          persistent: true,
          icon: asked ? "checklist" : "bubble-5",
          title,
          description,
          actions: [
            { label: language.t("notification.action.goToSession"), onClick: () => navigate(href) },
            { label: language.t("common.dismiss"), onClick: "dismiss" },
          ],
        }),
      )
    })
    onCleanup(unsubscribe)
  })

  // Opening a session (or its parent) clears its pending alert toast.
  createEffect(() => {
    const current = viewing()
    if (!current) return
    dismiss(current)
    toasts.forEach((_, sessionID) => {
      if (serverSync().session.peek(sessionID)?.parentID === current) dismiss(sessionID)
    })
  })

  onCleanup(() => toasts.forEach((toast) => dismissToast(toast)))

  return null
}
