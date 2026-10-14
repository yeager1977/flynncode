import { For, Show } from "solid-js"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Icon } from "@flynncode/ui/v2/icon"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSettingsDialog } from "@/components/settings-dialog"
import { displayName } from "./helpers"
import { LocalWorkspace } from "./sidebar-workspace"
import type { SidebarController } from "./sidebar-controller"

// Claude-desktop-style navigation: one column, projects as collapsible
// headers, their sessions underneath. Clicking a session only routes.
export function SessionSidebar(props: {
  sidebar: SidebarController
  mobile?: boolean
  onNewSession: (directory: string) => void
}) {
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettingsDialog()
  const current = () => props.sidebar.currentProject()?.worktree ?? layout.projects.list()[0]?.worktree

  return (
    <div class="size-full flex flex-col bg-v2-background-bg-deep">
      <div class="flex flex-col gap-0.5 p-2">
        <ButtonV2
          variant="ghost-muted"
          class="justify-start"
          data-action="sidebar-new-session"
          disabled={!current()}
          onClick={() => {
            const directory = current()
            if (directory) props.onNewSession(directory)
          }}
        >
          <Icon name="edit" />
          {language.t("command.session.new")}
        </ButtonV2>
        <ButtonV2 variant="ghost-muted" class="justify-start" data-action="sidebar-search" onClick={command.show}>
          <Icon name="magnifying-glass" />
          {language.t("home.sessions.search.placeholder")}
        </ButtonV2>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2">
        <For each={layout.projects.list()}>
          {(project) => (
            <div class="flex flex-col">
              <div class="group flex items-center h-8 rounded-md hover:bg-v2-background-bg-layer-01">
                <button
                  type="button"
                  class="flex-1 min-w-0 flex items-center gap-1.5 px-2 h-full text-left"
                  data-action="sidebar-project-toggle"
                  aria-expanded={project.expanded}
                  onClick={() =>
                    project.expanded
                      ? layout.projects.collapse(project.worktree)
                      : layout.projects.expand(project.worktree)
                  }
                >
                  <span class="shrink-0" classList={{ "-rotate-90": !project.expanded }}>
                    <Icon name="chevron-down" />
                  </span>
                  <span class="truncate font-medium">{displayName(project)}</span>
                </button>
                <button
                  type="button"
                  class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 px-2 h-full"
                  data-action="sidebar-project-new-session"
                  aria-label={language.t("command.session.new")}
                  onClick={() => props.onNewSession(project.worktree)}
                >
                  <Icon name="plus" />
                </button>
              </div>
              <Show when={project.expanded}>
                <LocalWorkspace
                  ctx={props.sidebar.workspaceSidebarCtx}
                  project={project}
                  sortNow={props.sidebar.sortNow}
                  mobile={props.mobile}
                  inline
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="flex flex-col gap-0.5 p-2 border-t border-v2-border-border-muted">
        <ButtonV2 variant="ghost-muted" class="justify-start" onClick={() => props.sidebar.chooseProject()}>
          <Icon name="folder-add-left" />
          {language.t("command.project.open")}
        </ButtonV2>
        <ButtonV2 variant="ghost-muted" class="justify-start" onClick={() => settings()}>
          <Icon name="settings-gear" />
          {language.t("command.settings.open")}
        </ButtonV2>
      </div>
    </div>
  )
}
