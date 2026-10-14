import { For, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { A } from "@solidjs/router"
import type { Session } from "@flynncode/sdk/v2/client"
import { Icon } from "@flynncode/ui/v2/icon"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { useServerSync } from "@/context/server-sync"
import { useSettingsDialog } from "@/components/settings-dialog"
import { displayName } from "./helpers"
import type { SidebarGroup } from "./sidebar-sessions"

// Sessions a project shows before "Show more".
export const SIDEBAR_SESSION_PREVIEW = 5

// Claude-desktop-style navigation: search and new session on top, then each
// open project as a quiet label over its sessions. Clicking a session only routes.
export function SessionSidebar(props: {
  groups: Accessor<SidebarGroup[]>
  activeSessionID: Accessor<string | undefined>
  currentDirectory: Accessor<string | undefined>
  sessionHref: (session: Session) => string
  onNewSession: (directory: string) => void
  onOpenProject: () => void
  shown: (group: SidebarGroup) => Session[]
  showAll: (worktree: string, value: boolean) => void
  showingAll: (worktree: string) => boolean
}) {
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettingsDialog()

  return (
    <div class="size-full flex flex-col bg-v2-background-bg-deep text-13-regular">
      <div class="flex flex-col gap-0.5 px-2 pt-2 pb-3">
        <button
          type="button"
          data-action="sidebar-search"
          class="flex items-center gap-2 h-8 px-2.5 mb-1.5 rounded-md border border-v2-border-border-muted text-v2-text-text-faint hover:bg-v2-overlay-simple-overlay-hover text-left"
          onClick={() => command.show()}
        >
          <Icon name="magnifying-glass" />
          <span class="truncate">{language.t("common.search.placeholder")}</span>
        </button>
        <SidebarRow
          icon="plus"
          label={language.t("command.session.new")}
          action="sidebar-new-session"
          disabled={!props.currentDirectory()}
          onClick={() => {
            const directory = props.currentDirectory()
            if (directory) props.onNewSession(directory)
          }}
        />
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2 pb-2 flex flex-col gap-4">
        <Show
          when={props.groups().length > 0}
          fallback={
            <div class="px-2.5 pt-2 flex flex-col gap-1">
              <span class="text-v2-text-text-base">{language.t("sidebar.empty.title")}</span>
              <span class="text-v2-text-text-faint">{language.t("sidebar.empty.description")}</span>
            </div>
          }
        >
          <For each={props.groups()}>
            {(group) => (
              <section class="flex flex-col gap-px" data-project={group.project.worktree}>
                <div class="group/project flex items-center h-7 pl-2.5 pr-1 text-12-regular text-v2-text-text-faint">
                  <span class="flex-1 min-w-0 truncate">{displayName(group.project)}</span>
                  <button
                    type="button"
                    data-action="sidebar-project-new-session"
                    aria-label={language.t("command.session.new")}
                    class="size-6 flex items-center justify-center rounded-md opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                    onClick={() => props.onNewSession(group.project.worktree)}
                  >
                    <Icon name="plus" />
                  </button>
                </div>
                <For each={props.shown(group)}>
                  {(session) => (
                    <SessionLink
                      session={session}
                      href={props.sessionHref(session)}
                      active={props.activeSessionID() === session.id}
                    />
                  )}
                </For>
                <Show when={group.sessions.length > SIDEBAR_SESSION_PREVIEW}>
                  <button
                    type="button"
                    data-action="sidebar-show-more"
                    class="h-7 pl-[30px] pr-2.5 rounded-md text-left text-v2-text-text-faint hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted"
                    onClick={() =>
                      props.showAll(group.project.worktree, !props.showingAll(group.project.worktree))
                    }
                  >
                    {props.showingAll(group.project.worktree)
                      ? language.t("sidebar.sessions.showLess")
                      : language.plural("sidebar.sessions.showMore", group.sessions.length - SIDEBAR_SESSION_PREVIEW)}
                  </button>
                </Show>
              </section>
            )}
          </For>
        </Show>
      </div>
      <div class="flex flex-col gap-0.5 p-2 border-t border-v2-border-border-muted">
        <SidebarRow
          icon="folder-add-left"
          label={language.t("command.project.open")}
          action="sidebar-open-project"
          onClick={props.onOpenProject}
        />
        <SidebarRow
          icon="settings-gear"
          label={language.t("sidebar.settings")}
          action="sidebar-settings"
          onClick={() => settings()}
        />
      </div>
    </div>
  )
}

function SidebarRow(props: {
  icon: "plus" | "folder-add-left" | "settings-gear"
  label: string
  action: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-action={props.action}
      disabled={props.disabled}
      class="flex items-center gap-2 h-7 px-2.5 rounded-md text-left text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:opacity-50 disabled:pointer-events-none"
      onClick={() => props.onClick()}
    >
      <span class="shrink-0 text-v2-icon-icon-muted">
        <Icon name={props.icon} />
      </span>
      <span class="truncate">{props.label}</span>
    </button>
  )
}

function SessionLink(props: { session: Session; href: string; active: boolean }) {
  const serverSync = useServerSync()
  const notification = useNotification()
  const working = () => serverSync().session.data.session_working(props.session.id)
  const unseen = () => notification.session.unseenCount(props.session.id) > 0

  return (
    <A
      href={props.href}
      data-session-id={props.session.id}
      class="flex items-center gap-2.5 h-7 pl-2.5 pr-2 rounded-md min-w-0"
      classList={{
        "bg-v2-background-bg-layer-02 text-v2-text-text-base": props.active,
        "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base": !props.active,
      }}
    >
      <span class="shrink-0 size-3 flex items-center justify-center">
        <span
          class="block rounded-full"
          classList={{
            "size-2 bg-v2-icon-icon-accent animate-pulse": working(),
            "size-2 bg-v2-icon-icon-accent": !working() && unseen(),
            "size-1.5 border border-v2-icon-icon-muted": !working() && !unseen(),
          }}
        />
      </span>
      <span class="truncate">{props.session.title}</span>
    </A>
  )
}
