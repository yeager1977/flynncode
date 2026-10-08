import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { useServerSync } from "@/context/server-sync"
import { useDispatchActivity } from "./dispatch-activity"

// Titlebar entry point for the Activity Inbox in the new layout. The panel
// loads lazily so the titlebar does not pull in the inbox and its settings
// dependencies at startup.
export function ActivityInboxButton() {
  const language = useLanguage()
  const dialog = useDialog()
  const badge = useInboxBadge()
  const open = () => {
    void import("./activity-inbox").then((mod) => dialog.show(() => <mod.ActivityInboxPanel />))
  }

  return (
    <TooltipV2 placement="bottom" value={language.t("inbox.title")} class="shrink-0">
      <div class="relative">
        <IconButtonV2
          type="button"
          data-action="titlebar-inbox"
          variant="ghost-muted"
          size="large"
          class="!w-9 shrink-0"
          icon={<IconV2 name="inbox" />}
          onClick={open}
          aria-label={badge() > 0 ? language.t("inbox.unreadLabel", { count: badge() }) : language.t("inbox.title")}
        />
        <Show when={badge() > 0}>
          <Tag variant="accent" class="pointer-events-none absolute -right-0.5 -top-0.5 min-w-4" aria-hidden="true">
            {badge()}
          </Tag>
        </Show>
      </div>
    </TooltipV2>
  )
}

// Inbox-wide unread: dispatch flags plus unseen notifications on top-level
// sessions that are not tracked as dispatch rows (capped-out tasks still
// surface here instead of being silently dropped).
export function useInboxBadge() {
  const activity = useDispatchActivity()
  const notification = useNotification()
  const layout = useLayout()
  const serverSync = useServerSync()
  return () => {
    const tasks = activity.desk.tasks
    const dispatched = new Set(tasks.map((task) => task.sessionID))
    const dispatchUnread = tasks.filter(
      (task) => task.unread || notification.session.unseenCount(task.sessionID) > 0,
    ).length
    const sessionUnread = layout.projects
      .list()
      .flatMap((project) => serverSync().child(project.worktree, { bootstrap: false })[0].session ?? [])
      .filter((session) => {
        if (dispatched.has(session.id)) return false
        if (session.parentID) return false
        if (session.time?.archived) return false
        return notification.session.unseenCount(session.id) > 0
      }).length
    return dispatchUnread + sessionUnread
  }
}
