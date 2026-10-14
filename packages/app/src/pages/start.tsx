import { createEffect, createMemo, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { draftHref, useTabs } from "@/context/tabs"
import { projectDraft } from "@/pages/layout/new-layout-sidebar"

// The new layout's "/" has no page of its own: the sidebar is the session
// browser, so landing here opens (or reuses) a new session in the current
// project, the way Claude desktop opens on a fresh chat.
export function StartRoute() {
  const layout = useLayout()
  const server = useServer()
  const tabs = useTabs()
  const navigate = useNavigate()
  const command = useCommand()
  const language = useLanguage()
  const directory = createMemo(() => {
    const projects = layout.projects.list()
    const last = server.projects.last()
    return (projects.find((project) => project.worktree === last) ?? projects[0])?.worktree
  })

  createEffect(() => {
    if (!layout.ready() || !tabs.ready()) return
    const target = directory()
    if (!target) return
    const draft = projectDraft(tabs.store, server.key, target)
    if (draft) {
      navigate(draftHref(draft.draftID, draft.kind), { replace: true })
      return
    }
    void tabs.newDraft({ server: server.key, directory: target }, undefined, undefined, { replace: true })
  })

  return (
    <Show when={layout.ready() && !directory()}>
      <div class="size-full flex flex-col items-center justify-center gap-3 text-13-regular">
        <span class="text-v2-text-text-base">{language.t("sidebar.empty.title")}</span>
        <span class="text-v2-text-text-faint">{language.t("sidebar.empty.description")}</span>
        <ButtonV2 variant="outline" icon="folder-add-left" onClick={() => command.trigger("project.open")}>
          {language.t("command.project.open")}
        </ButtonV2>
      </div>
    </Show>
  )
}
