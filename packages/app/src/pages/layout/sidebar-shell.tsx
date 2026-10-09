import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { type LocalProject } from "@/context/layout"

export type SidebarFooter = {
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  helpLabel: Accessor<string>
  onOpenHelp: () => void
  dispatchLabel: Accessor<string>
  dispatchUnread: Accessor<number>
  onOpenDispatch: () => void
}

export const SidebarContent = (props: {
  // v2 is the new layout's rail: flat on the window chrome, v2 controls, and no
  // footer (Settings and the inbox live elsewhere there).
  variant?: "classic" | "v2"
  mobile?: boolean
  opened: Accessor<boolean>
  aimMove: (event: MouseEvent) => void
  projects: Accessor<LocalProject[]>
  renderProject: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  openProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  footer?: SidebarFooter
  renderPanel: () => JSX.Element
}): JSX.Element => {
  const v2 = props.variant === "v2"
  const expanded = createMemo(() => !!props.mobile || props.opened())
  const placement = () => (props.mobile ? "bottom" : "right")
  let panel: HTMLDivElement | undefined

  createEffect(() => {
    const el = panel
    if (!el) return
    if (expanded()) {
      el.removeAttribute("inert")
      return
    }
    el.setAttribute("inert", "")
  })

  return (
    <div class="flex h-full w-full min-w-0 overflow-hidden">
      <div
        data-component="sidebar-rail"
        class="w-16 shrink-0 flex flex-col items-center overflow-hidden"
        classList={{ "bg-background-base": !v2 }}
        onMouseMove={props.aimMove}
      >
        <div class="flex-1 min-h-0 w-full">
          <DragDropProvider
            onDragStart={props.handleDragStart}
            onDragEnd={props.handleDragEnd}
            onDragOver={props.handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragXAxis />
            <div class="h-full w-full flex flex-col items-center gap-3 px-3 py-3 overflow-y-auto no-scrollbar">
              <SortableProvider ids={props.projects().map((p) => p.worktree)}>
                <For each={props.projects()}>{(project) => props.renderProject(project)}</For>
              </SortableProvider>
              <Show
                when={v2}
                fallback={
                  <Tooltip
                    placement={placement()}
                    value={
                      <div class="flex items-center gap-2">
                        <span>{props.openProjectLabel}</span>
                        <Show when={!props.mobile && !!props.openProjectKeybind()}>
                          <span class="text-icon-base text-12-medium">{props.openProjectKeybind()}</span>
                        </Show>
                      </div>
                    }
                  >
                    <IconButton
                      icon="plus"
                      variant="ghost"
                      size="large"
                      onClick={props.onOpenProject}
                      aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                    />
                  </Tooltip>
                }
              >
                <TooltipV2 placement={placement()} value={props.openProjectLabel}>
                  <IconButtonV2
                    type="button"
                    variant="ghost-muted"
                    size="large"
                    class="!size-10"
                    icon={<IconV2 name="folder-add-left" />}
                    data-action="sidebar-open-project"
                    onClick={props.onOpenProject}
                    aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                  />
                </TooltipV2>
              </Show>
            </div>
            <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
          </DragDropProvider>
        </div>
        <Show when={props.footer}>
          {(footer) => (
            <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">
              <div class="relative">
                <Tooltip placement={placement()} value={footer().dispatchLabel()}>
                  <IconButton
                    icon="plus"
                    variant="ghost"
                    size="large"
                    onClick={footer().onOpenDispatch}
                    aria-label={footer().dispatchLabel()}
                  />
                </Tooltip>
                <Show when={footer().dispatchUnread() > 0}>
                  <span class="pointer-events-none absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-surface-raised px-1 text-12-regular text-text-strong">
                    {footer().dispatchUnread()}
                  </span>
                </Show>
              </div>
              <TooltipKeybind
                placement={placement()}
                title={footer().settingsLabel()}
                keybind={footer().settingsKeybind() ?? ""}
              >
                <IconButton
                  icon="settings-gear"
                  variant="ghost"
                  size="large"
                  onClick={footer().onOpenSettings}
                  aria-label={footer().settingsLabel()}
                />
              </TooltipKeybind>
              <Tooltip placement={placement()} value={footer().helpLabel()}>
                <IconButton
                  icon="help"
                  variant="ghost"
                  size="large"
                  onClick={footer().onOpenHelp}
                  aria-label={footer().helpLabel()}
                />
              </Tooltip>
            </div>
          )}
        </Show>
      </div>

      <div
        ref={(el) => {
          panel = el
        }}
        classList={{ "flex-1 flex h-full min-h-0 min-w-0 overflow-hidden": true, "pointer-events-none": !expanded() }}
        aria-hidden={!expanded()}
      >
        {props.renderPanel()}
      </div>
    </div>
  )
}
