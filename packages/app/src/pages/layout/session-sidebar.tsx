import { createEffect, For, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { A } from "@solidjs/router"
import { MenuV2 } from "@flynncode/ui/v2/menu-v2"
import type { Session } from "@flynncode/sdk/v2/client"
import { Icon } from "@flynncode/ui/v2/icon"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettingsDialog } from "@/components/settings-dialog"
import { ProviderUsageMeters } from "@/components/provider-usage-meters"
import { showToast } from "@/utils/toast"
import type { LocalProject } from "@/context/layout"
import { displayName } from "./helpers"
import { dispatchContextMenu } from "./keyboard-menu"
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
  onArchive: (session: Session) => void
  onEditProject: (project: LocalProject) => void
  onHideProject: (worktree: string) => void
  onUnhideProject: (worktree: string) => void
  onForgetProject: (project: LocalProject) => void
  hiddenProjects: Accessor<LocalProject[]>
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
                <ProjectHeader
                  project={group.project}
                  onNewSession={props.onNewSession}
                  onEditProject={props.onEditProject}
                  onHideProject={props.onHideProject}
                  onForgetProject={props.onForgetProject}
                />
                <For each={props.shown(group)}>
                  {(session) => (
                    <SessionLink
                      session={session}
                      href={props.sessionHref(session)}
                      active={props.activeSessionID() === session.id}
                      onArchive={props.onArchive}
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
        {/* Outside the groups' Show: hidden projects stay manageable even
            when every visible list is empty. */}
        <HiddenProjectsSection
          projects={props.hiddenProjects}
          onUnhideProject={props.onUnhideProject}
          onForgetProject={props.onForgetProject}
        />
      </div>
      <div class="flex flex-col gap-0.5 p-2 border-t border-v2-border-border-muted">
        {/* Usage rings stay visible here with the project actions: context of
            the open session plus the engaged provider's quota windows. */}
        <ProviderUsageMeters variant="rings" sessionID={props.activeSessionID} row />
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

// A quiet project label with the management menu on right-click: new session,
// edit, hide, forget. Hiding tucks the project into the hidden section below.
// The header is a tab stop; Enter-less keys — the ContextMenu key or Shift+F10
// — open the same menu for keyboard users.
function ProjectHeader(props: {
  project: LocalProject
  onNewSession: (directory: string) => void
  onEditProject: (project: LocalProject) => void
  onHideProject: (worktree: string) => void
  onForgetProject: (project: LocalProject) => void
}) {
  const language = useLanguage()
  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger
        as="div"
        tabindex="0"
        aria-label={props.project.name ?? displayName(props.project)}
        class="rounded-md outline outline-1 outline-transparent focus-visible:outline-v2-border-border-focus group/project flex items-center h-7 pl-2.5 pr-1 text-12-regular text-v2-text-text-faint"
        onKeyDown={(event) => {
          dispatchContextMenu(event.currentTarget, event)
        }}
      >
        <span class="flex-1 min-w-0 truncate">{displayName(props.project)}</span>
        <button
          type="button"
          data-action="sidebar-project-new-session"
          data-project={props.project.worktree}
          aria-label={language.t("command.session.new")}
          class="size-6 flex items-center justify-center rounded-md opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
          onClick={() => props.onNewSession(props.project.worktree)}
        >
          <Icon name="plus" />
        </button>
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content>
          <MenuV2.Item
            data-action="sidebar-project-menu-new-session"
            data-project={props.project.worktree}
            onSelect={() => props.onNewSession(props.project.worktree)}
          >
            {language.t("command.session.new")}
          </MenuV2.Item>
          <MenuV2.Item
            data-action="sidebar-project-edit"
            data-project={props.project.worktree}
            onSelect={() => props.onEditProject(props.project)}
          >
            {language.t("common.edit")}
          </MenuV2.Item>
          <MenuV2.Item
            data-action="sidebar-project-hide"
            data-project={props.project.worktree}
            onSelect={() => props.onHideProject(props.project.worktree)}
          >
            {language.t("sidebar.project.hide")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item
            data-action="sidebar-project-forget"
            data-project={props.project.worktree}
            onSelect={() => props.onForgetProject(props.project)}
          >
            {language.t("sidebar.project.forget")}
          </MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}

// Hidden projects stay reachable: a row un-hides on click, and the context
// menu offers Show and Forget.
function HiddenProjectsSection(props: {
  projects: Accessor<LocalProject[]>
  onUnhideProject: (worktree: string) => void
  onForgetProject: (project: LocalProject) => void
}) {
  const language = useLanguage()
  return (
    <Show when={props.projects().length > 0}>
      <div class="flex flex-col gap-px" data-sidebar-hidden-projects>
        <div class="h-7 flex items-center pl-2.5 text-12-regular text-v2-text-text-faint">
          {language.t("sidebar.project.hidden")}
        </div>
        <For each={props.projects()}>
          {(project) => (
            <MenuV2.Context>
              <MenuV2.Context.Trigger
                as="button"
                type="button"
                data-action="sidebar-project-hidden"
                data-project={project.worktree}
                title={language.t("sidebar.project.show")}
                class="group/hidden flex items-center h-7 pl-2.5 pr-2 rounded-md text-left text-v2-text-text-faint hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted"
                onClick={() => props.onUnhideProject(project.worktree)}
                onKeyDown={(event) => {
                  dispatchContextMenu(event.currentTarget, event)
                }}
              >
                <span class="flex-1 min-w-0 truncate">{displayName(project)}</span>
              </MenuV2.Context.Trigger>
              <MenuV2.Context.Portal>
                <MenuV2.Context.Content>
                  <MenuV2.Item
                    data-action="sidebar-project-show"
                    data-project={project.worktree}
                    onSelect={() => props.onUnhideProject(project.worktree)}
                  >
                    {language.t("sidebar.project.show")}
                  </MenuV2.Item>
                  <MenuV2.Item
                    data-action="sidebar-project-forget"
                    data-project={project.worktree}
                    onSelect={() => props.onForgetProject(project)}
                  >
                    {language.t("sidebar.project.forget")}
                  </MenuV2.Item>
                </MenuV2.Context.Content>
              </MenuV2.Context.Portal>
            </MenuV2.Context>
          )}
        </For>
      </div>
    </Show>
  )
}

function SessionLink(props: { session: Session; href: string; active: boolean; onArchive: (session: Session) => void }) {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const notification = useNotification()
  const language = useLanguage()
  // `title` shows a rename optimistically until the session index reports it.
  const [state, setState] = createStore({
    renaming: false,
    pendingRename: false,
    draft: "",
    title: undefined as string | undefined,
  })
  const working = () => serverSync().session.data.session_working(props.session.id)
  const unseen = () => notification.session.unseenCount(props.session.id) > 0
  const title = () => state.title ?? props.session.title
  // Drop the optimistic title once the index catches up.
  createEffect(() => {
    if (state.title !== undefined && props.session.title === state.title) setState("title", undefined)
  })

  const commit = () => {
    if (!state.renaming) return
    const next = state.draft.trim()
    setState("renaming", false)
    if (!next || next === title()) return
    setState("title", next)
    void serverSDK()
      .api.session.rename({ sessionID: props.session.id, title: next, directory: props.session.directory })
      .catch((err: unknown) => {
        setState("title", undefined)
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : undefined,
        })
      })
  }

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger
        as="div"
        data-session-id={props.session.id}
        class="flex items-center gap-2.5 h-7 pl-2.5 pr-2 rounded-md min-w-0"
        classList={{
          "bg-v2-background-bg-layer-02 text-v2-text-text-base": props.active || state.renaming,
          "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base":
            !props.active && !state.renaming,
        }}
      >
        <span class="shrink-0 size-3 flex items-center justify-center">
          <Show
            when={working() || unseen()}
            fallback={<span class="block rounded-full size-1.5 border border-v2-icon-icon-muted" />}
          >
            <TooltipV2 placement="top" value={working() ? language.t("sidebar.dot.working") : language.t("sidebar.dot.unseen")}>
              <span class="block rounded-full size-2 bg-v2-icon-icon-accent" classList={{ "animate-pulse": working() }} />
            </TooltipV2>
          </Show>
        </span>
        <Show
          when={state.renaming}
          fallback={
            <A href={props.href} class="flex-1 min-w-0 truncate leading-7">
              {title()}
            </A>
          }
        >
          <input
            ref={(el) => queueMicrotask(() => el.select())}
            data-action="sidebar-session-rename"
            class="flex-1 min-w-0 bg-transparent outline-none text-v2-text-text-base"
            value={state.draft}
            aria-label={language.t("common.rename")}
            onInput={(event) => setState("draft", event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commit()
                return
              }
              if (event.key !== "Escape") return
              event.preventDefault()
              setState("renaming", false)
            }}
          />
        </Show>
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content
          onCloseAutoFocus={(event) => {
            // Start editing only after the menu has returned focus, or it steals the input's focus.
            if (!state.pendingRename) return
            event.preventDefault()
            setState({ pendingRename: false, renaming: true, draft: title() })
          }}
        >
          <MenuV2.Item onSelect={() => setState("pendingRename", true)}>{language.t("common.rename")}</MenuV2.Item>
          <MenuV2.Item onSelect={() => props.onArchive(props.session)}>{language.t("common.archive")}</MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}
