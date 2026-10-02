import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { Binary } from "@opencode-ai/core/util/binary"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync, useQueryOptions } from "@/context/server-sync"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"
import { listAllSessions } from "@/utils/session"
import { showToast } from "@/utils/toast"
import {
  BULK_PRESETS,
  cleanupCandidates,
  presetDays,
  protectedRootIDs,
  selectLoaded,
  selectRange,
  toggleID,
  type BulkPreset,
} from "../session/session-bulk"
import { BulkConfirmDialog } from "../session/session-bulk-dialog"
import { runSessionBulk, type BulkOp } from "../session/session-bulk-run"
import { NewSessionItem, SessionItem, SessionSkeleton } from "./sidebar-items"
import { sortedRootSessions } from "./helpers"
import { useIsFetching } from "@tanstack/solid-query"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  navList: Accessor<Session[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
}

export const WorkspaceDragOverlay = (props: {
  sidebarProject: Accessor<LocalProject | undefined>
  activeWorkspace: Accessor<string | undefined>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.sidebarProject()
    if (!project) return
    const directory = props.activeWorkspace()
    if (!directory) return

    const [workspaceStore] = serverSync().child(directory, { bootstrap: false })
    const kind =
      directory === project.worktree ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
    const name = props.workspaceLabel(directory, workspaceStore.vcs?.branch, project.id)
    return `${kind} : ${name}`
  })

  return (
    <Show when={label()}>
      {(value) => <div class="bg-background-base rounded-md px-2 py-1 text-14-medium text-text-strong">{value()}</div>}
    </Show>
  )
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
  projectId?: string
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" size="small" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <span class="text-14-medium text-text-base shrink-0">
      {props.local() ? props.language.t("workspace.type.local") : props.language.t("workspace.type.sandbox")} :
    </span>
    <Show
      when={!props.local()}
      fallback={
        <span class="text-14-medium text-text-base min-w-0 truncate">
          {props.branch() ?? getFilename(props.directory)}
        </span>
      }
    >
      <props.InlineEditor
        id={`workspace:${props.directory}`}
        value={props.workspaceValue}
        onSave={(next) => {
          const trimmed = next.trim()
          if (!trimmed) return
          props.renameWorkspace(props.directory, trimmed, props.projectId, props.branch())
          props.setEditor("value", props.workspaceValue())
        }}
        class="text-14-medium text-text-base min-w-0 truncate"
        displayClass="text-14-medium text-text-base min-w-0 truncate"
        editing={props.workspaceEditActive()}
        stopPropagation={false}
        openOnDblClick={false}
      />
    </Show>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  pendingRename: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  setPendingRename: (value: boolean) => void
  sidebarHovering: Accessor<boolean>
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  openEditor: WorkspaceSidebarContext["openEditor"]
  showResetWorkspaceDialog: WorkspaceSidebarContext["showResetWorkspaceDialog"]
  showDeleteWorkspaceDialog: WorkspaceSidebarContext["showDeleteWorkspaceDialog"]
  root: string
  clearHoverProjectSoon: WorkspaceSidebarContext["clearHoverProjectSoon"]
  navigateToNewSession: () => void
}): JSX.Element => (
  <div
    class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity"
    classList={{
      "opacity-100 pointer-events-auto": props.menuOpen(),
      "opacity-0 pointer-events-none": !props.menuOpen(),
      "group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto": true,
      "group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto": true,
    }}
  >
    <DropdownMenu
      modal={!props.sidebarHovering()}
      open={props.menuOpen()}
      onOpenChange={(open) => props.setMenuOpen(open)}
    >
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          class="size-6 rounded-md"
          data-action="workspace-menu"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("common.moreOptions")}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          onCloseAutoFocus={(event) => {
            if (!props.pendingRename()) return
            event.preventDefault()
            props.setPendingRename(false)
            props.openEditor(`workspace:${props.directory}`, props.workspaceValue())
          }}
        >
          <DropdownMenu.Item
            disabled={props.local()}
            onSelect={() => {
              props.setPendingRename(true)
              props.setMenuOpen(false)
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
    <Show when={!props.touch()}>
      <Tooltip value={props.language.t("command.session.new")} placement="top">
        <IconButtonV2
          icon={<IconV2 name="edit" size="small" />}
          variant="ghost"
          size="small"
          class="size-6 rounded-md opacity-0 pointer-events-none group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto"
          data-action="workspace-new-session"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("command.session.new")}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.clearHoverProjectSoon()
            props.navigateToNewSession()
          }}
        />
      </Tooltip>
    </Show>
  </div>
)

function mergeSessions(left: readonly Session[], right: readonly Session[]) {
  const byID = new Map<string, Session>()
  for (const session of left) byID.set(session.id, session)
  for (const session of right) byID.set(session.id, session)
  return [...byID.values()]
}

function useWorkspaceBulk(input: {
  directory: () => string
  sessions: () => Session[]
  active: () => boolean
  expanded: () => boolean
}) {
  const params = useParams()
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const tabs = useTabs()
  const [bulk, setBulk] = createStore({
    selecting: false,
    selected: [] as string[],
    anchor: undefined as string | undefined,
    busy: false,
  })
  let generation = 0
  const clearBulk = () => {
    generation += 1
    setBulk({ selecting: false, selected: [], anchor: undefined, busy: false })
  }
  const known = () => serverSync().child(input.directory(), { bootstrap: false })[0].session ?? []
  const pending = (id: string) => {
    const data = serverSync().session.data
    return (data.permission[id]?.length ?? 0) > 0 || (data.question[id]?.length ?? 0) > 0
  }
  const openTabIDs = (list: readonly Session[]) => {
    const ids = new Set<string>()
    for (const tab of tabs.store) {
      if (tab.type === "session" && tab.server === server.key) ids.add(tab.sessionId)
    }
    for (const session of list) {
      if (sessionHasOpenTab(tabs.store, server.key, session)) ids.add(session.id)
    }
    return ids
  }
  const blockedFor = (list: readonly Session[]) =>
    protectedRootIDs(list, {
      openRouteID: params.id,
      openTabIDs: openTabIDs(list),
      working: (id) => serverSync().session.data.session_working(id),
      pending,
    })
  const allowed = createMemo(() => {
    const blocked = blockedFor(known())
    return new Set(input.sessions().map((session) => session.id).filter((id) => !blocked.has(id)))
  })
  const forget = (id: string) => {
    const [, setStore] = serverSync().child(input.directory(), { bootstrap: false })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, id, (item) => item.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    serverSync().homeSessions.remove(id)
    notifySessionTabsRemoved({ directory: input.directory(), sessionIDs: [id] })
  }
  const archiveOne = async (sessionID: string) => {
    const archived = Date.now()
    await serverSDK().client.session.update({ sessionID, directory: input.directory(), time: { archived } })
    forget(sessionID)
  }
  const removeOne = async (sessionID: string) => {
    await serverSDK().api.session.remove({ sessionID })
    forget(sessionID)
  }
  const run = async (op: BulkOp, ids: readonly string[], extra: readonly Session[]) => {
    if (bulk.busy) return
    const ticket = generation
    setBulk("busy", true)
    dialog.close()
    const result = await runSessionBulk({
      ids,
      op,
      isProtected: (id) => blockedFor(mergeSessions(known(), extra)).has(id),
      archive: archiveOne,
      remove: removeOne,
    })
    if (ticket !== generation) return
    if (result.failed) {
      showToast({ title: language.plural("session.bulk.failed", result.pending.length + 1) })
      setBulk({
        selecting: true,
        selected: [result.failed, ...result.pending],
        anchor: result.failed,
        busy: false,
      })
      return
    }
    clearBulk()
  }
  const confirm = (op: BulkOp) => {
    if (bulk.busy) return
    const ids = bulk.selected.filter((id) => allowed().has(id))
    if (ids.length === 0) return
    const frozen = [...ids]
    const extra = known()
    dialog.show(() => (
      <BulkConfirmDialog
        op={op}
        count={frozen.length}
        busy={bulk.busy}
        onCancel={() => dialog.close()}
        onConfirm={() => {
          void run(op, frozen, extra)
        }}
      />
    ))
  }
  const cleanup = async (id: BulkPreset) => {
    if (bulk.busy) return
    const ticket = generation
    setBulk("busy", true)
    const fetched = await listAllSessions(serverSDK().api.session, {
      directory: input.directory(),
      order: "desc",
    }).catch(() => undefined)
    if (ticket !== generation) return
    setBulk("busy", false)
    if (!fetched) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    if (ticket !== generation) return
    const now = Date.now()
    const extra = mergeSessions(known(), fetched)
    const found = cleanupCandidates(fetched, now, presetDays(id), blockedFor(extra))
    if (found.match.length === 0) {
      dialog.show(() => (
        <BulkConfirmDialog
          op="archive"
          count={0}
          empty
          busy={bulk.busy}
          onCancel={() => dialog.close()}
          onConfirm={() => {}}
        />
      ))
      return
    }
    const ids = found.match.map((session) => session.id)
    const period = language.t(`session.bulk.period.${id}`)
    const matchLabel = language.plural("session.bulk.cleanup.match", found.match.length, { period })
    const skippedLabel =
      found.skipped.length > 0 ? language.plural("session.bulk.cleanup.skipped", found.skipped.length) : undefined
    dialog.show(() => (
      <BulkConfirmDialog
        op="archive"
        count={ids.length}
        matchLabel={matchLabel}
        skippedLabel={skippedLabel}
        busy={bulk.busy}
        onCancel={() => dialog.close()}
        onConfirm={() => {}}
        onArchive={() => {
          void run("archive", ids, extra)
        }}
        onDelete={() => {
          void run("delete", ids, extra)
        }}
      />
    ))
  }
  const toggleSelect = () => {
    if (bulk.busy) return
    if (bulk.selecting) {
      clearBulk()
      return
    }
    setBulk("selecting", true)
  }
  const selectAll = () => {
    if (bulk.busy) return
    setBulk(
      "selected",
      selectLoaded(
        input.sessions().map((session) => session.id),
        allowed(),
      ),
    )
  }
  const onToggle = (id: string, event: MouseEvent) => {
    if (bulk.busy) return
    if (event.shiftKey) {
      const next = selectRange({
        order: input.sessions().map((session) => session.id),
        selected: bulk.selected,
        anchor: bulk.anchor,
        id,
        allowed: allowed(),
      })
      setBulk("selected", next.selected)
      setBulk("anchor", next.anchor)
      return
    }
    setBulk("selected", toggleID(bulk.selected, id, allowed()))
    setBulk("anchor", id)
  }

  createEffect(() => {
    if (!bulk.selecting) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      clearBulk()
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  let sawActive = false
  let sawExpanded = false
  let ready = false
  createEffect(() => {
    const active = input.active()
    const expanded = input.expanded()
    if (ready && sawActive && !active) clearBulk()
    if (ready && sawExpanded && !expanded) clearBulk()
    sawActive = active
    sawExpanded = expanded
    ready = true
  })

  let seenDirectory: string | undefined
  createEffect(() => {
    const next = input.directory()
    if (seenDirectory !== undefined && seenDirectory !== next) clearBulk()
    seenDirectory = next
  })

  onCleanup(() => {
    generation += 1
  })

  return {
    store: bulk,
    locked: (id: string) => !allowed().has(id),
    onToggle,
    toggleSelect,
    selectAll,
    confirm,
    cleanup,
    clearBulk,
  }
}

function SessionBulkBar(props: {
  selecting: boolean
  count: number
  busy: boolean
  onToggleSelect: () => void
  onSelectAll: () => void
  onArchive: () => void
  onDelete: () => void
  onCancel: () => void
  onCleanup: (id: BulkPreset) => void
}) {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-1 px-2 py-1">
      <div class="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="small"
          disabled={props.busy}
          aria-pressed={props.selecting}
          onClick={props.onToggleSelect}
        >
          {language.t("session.bulk.select")}
        </Button>
        <DropdownMenu>
          <DropdownMenu.Trigger
            as={Button}
            variant="ghost"
            size="small"
            disabled={props.busy}
            aria-label={language.t("session.bulk.cleanup")}
          >
            {language.t("session.bulk.cleanup")}
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <For each={BULK_PRESETS}>
                {(preset) => (
                  <DropdownMenu.Item disabled={props.busy} onSelect={() => props.onCleanup(preset.id)}>
                    <DropdownMenu.ItemLabel>{language.t(`session.bulk.period.${preset.id}`)}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                )}
              </For>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
      <Show when={props.selecting}>
        <div class="flex flex-wrap items-center gap-1">
          <span class="text-12-regular text-text-weak">{language.plural("session.bulk.selected", props.count)}</span>
          <Button variant="ghost" size="small" disabled={props.busy} onClick={props.onSelectAll}>
            {language.t("session.bulk.selectAll")}
          </Button>
          <Button variant="ghost" size="small" disabled={props.busy || props.count === 0} onClick={props.onArchive}>
            {language.t("session.bulk.archive")}
          </Button>
          <Button variant="ghost" size="small" disabled={props.busy || props.count === 0} onClick={props.onDelete}>
            {language.t("session.bulk.delete")}
          </Button>
          <Button variant="ghost" size="small" onClick={props.onCancel}>
            {language.t("session.bulk.cancel")}
          </Button>
        </div>
      </Show>
    </div>
  )
}

const WorkspaceSessionList = (props: {
  slug: Accessor<string>
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  sessions: Accessor<Session[]>
  hasMore: Accessor<boolean>
  loadMore: () => Promise<void>
  language: ReturnType<typeof useLanguage>
  selecting?: boolean
  selected?: readonly string[]
  locked?: (id: string) => boolean
  onToggle?: (id: string, event: MouseEvent) => void
}): JSX.Element => (
  <nav class="flex flex-col gap-1">
    <Show when={props.showNew()}>
      <NewSessionItem
        slug={props.slug()}
        mobile={props.mobile}
        sidebarExpanded={props.ctx.sidebarExpanded}
        clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
      />
    </Show>
    <Show when={props.loading()}>
      <SessionSkeleton />
    </Show>
    <For each={props.sessions()}>
      {(session) => (
        <SessionItem
          session={session}
          list={props.sessions()}
          navList={props.ctx.navList}
          slug={props.slug()}
          mobile={props.mobile}
          showChild
          sidebarExpanded={props.ctx.sidebarExpanded}
          clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
          prefetchSession={props.ctx.prefetchSession}
          archiveSession={props.ctx.archiveSession}
          selecting={props.selecting}
          selected={props.selected?.includes(session.id)}
          locked={props.locked?.(session.id)}
          onToggle={props.onToggle ? (event) => props.onToggle?.(session.id, event) : undefined}
        />
      )}
    </For>
    <Show when={props.hasMore()}>
      <div class="relative w-full py-1">
        <Button
          variant="ghost"
          class="flex w-full text-left justify-start text-14-regular text-text-weak pl-2 pr-10"
          size="large"
          onClick={(e: MouseEvent) => {
            void props.loadMore()
            ;(e.currentTarget as HTMLButtonElement).blur()
          }}
        >
          {props.language.t("common.loadMore")}
        </Button>
      </div>
    </Show>
  </nav>
)

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const navigate = useNavigate()
  const params = useParams()
  const serverSync = useServerSync()
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const sortable = createSortable(props.directory)
  const [workspaceStore, setWorkspaceStore] = serverSync().child(props.directory, { bootstrap: false })
  const [menu, setMenu] = createStore({
    open: false,
    pendingRename: false,
  })
  const slug = createMemo(() => base64Encode(props.directory))
  const sessions = createMemo(() => sortedRootSessions(workspaceStore, props.sortNow()))
  const local = createMemo(() => props.directory === props.project.worktree)
  const active = createMemo(() => pathKey(props.ctx.currentDir()) === pathKey(props.directory))
  const workspaceValue = createMemo(() => {
    const branch = workspaceStore.vcs?.branch
    const name = branch ?? getFilename(props.directory)
    return props.ctx.workspaceName(props.directory, props.project.id, branch) ?? name
  })
  const open = createMemo(() => props.ctx.workspaceExpanded(props.directory, local()))
  const bulk = useWorkspaceBulk({
    directory: () => props.directory,
    sessions,
    active,
    expanded: open,
  })
  const boot = createMemo(() => open() || active())
  const count = createMemo(() => sessions()?.length ?? 0)
  const hasMore = createMemo(() => workspaceStore.sessionTotal > count())
  const fetching = useIsFetching(() => queryOptions().sessions(pathKey(props.directory)))
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const loading = () => fetching() > 0 && count() === 0
  const touch = createMediaQuery("(hover: none)")
  const showNew = createMemo(() => !loading() && (touch() || count() === 0 || (active() && !params.id)))
  const loadMore = async () => {
    setWorkspaceStore("limit", (limit) => (limit ?? 0) + 5)
    await serverSync().project.loadSessions(props.directory)
  }

  const workspaceEditActive = createMemo(() => props.ctx.editorOpen(`workspace:${props.directory}`))
  const header = () => (
    <WorkspaceHeader
      local={local}
      busy={busy}
      open={open}
      directory={props.directory}
      language={language}
      branch={() => workspaceStore.vcs?.branch}
      workspaceValue={workspaceValue}
      workspaceEditActive={workspaceEditActive}
      InlineEditor={props.ctx.InlineEditor}
      renameWorkspace={props.ctx.renameWorkspace}
      setEditor={props.ctx.setEditor}
      projectId={props.project.id}
    />
  )

  const openWrapper = (value: boolean) => {
    props.ctx.setWorkspaceExpanded(props.directory, value)
    if (value) return
    if (props.ctx.editorOpen(`workspace:${props.directory}`)) props.ctx.closeEditor()
  }

  createEffect(() => {
    if (!boot()) return
    serverSync().child(props.directory, { bootstrap: true })
  })

  return (
    <div
      // @ts-ignore
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50 pointer-events-none": busy(),
      }}
    >
      <Collapsible variant="ghost" open={open()} class="shrink-0" onOpenChange={openWrapper}>
        <div class="py-1">
          <div
            class="group/workspace relative"
            data-component="workspace-item"
            data-workspace={base64Encode(props.directory)}
          >
            <div class="flex items-center gap-1">
              <Show
                when={workspaceEditActive()}
                fallback={
                  <Collapsible.Trigger
                    class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover transition-[padding] duration-200 ${
                      menu.open ? "pr-16" : "pr-2"
                    } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                    data-action="workspace-toggle"
                    data-workspace={base64Encode(props.directory)}
                  >
                    {header()}
                  </Collapsible.Trigger>
                }
              >
                <div
                  class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md transition-[padding] duration-200 ${
                    menu.open ? "pr-16" : "pr-2"
                  } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                >
                  {header()}
                </div>
              </Show>
              <WorkspaceActions
                directory={props.directory}
                local={local}
                busy={busy}
                menuOpen={() => menu.open}
                pendingRename={() => menu.pendingRename}
                setMenuOpen={(open) => setMenu("open", open)}
                setPendingRename={(value) => setMenu("pendingRename", value)}
                sidebarHovering={props.ctx.sidebarHovering}
                touch={touch}
                language={language}
                workspaceValue={workspaceValue}
                openEditor={props.ctx.openEditor}
                showResetWorkspaceDialog={props.ctx.showResetWorkspaceDialog}
                showDeleteWorkspaceDialog={props.ctx.showDeleteWorkspaceDialog}
                root={props.project.worktree}
                clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                navigateToNewSession={() => navigate(`/${slug()}/session`)}
              />
            </div>
          </div>
        </div>

        <Collapsible.Content>
          <SessionBulkBar
            selecting={bulk.store.selecting}
            count={bulk.store.selected.length}
            busy={bulk.store.busy}
            onToggleSelect={bulk.toggleSelect}
            onSelectAll={bulk.selectAll}
            onArchive={() => bulk.confirm("archive")}
            onDelete={() => bulk.confirm("delete")}
            onCancel={bulk.clearBulk}
            onCleanup={(id) => {
              void bulk.cleanup(id)
            }}
          />
          <WorkspaceSessionList
            slug={slug}
            mobile={props.mobile}
            ctx={props.ctx}
            showNew={showNew}
            loading={loading}
            sessions={sessions}
            hasMore={hasMore}
            loadMore={loadMore}
            language={language}
            selecting={bulk.store.selecting}
            selected={bulk.store.selected}
            locked={bulk.locked}
            onToggle={bulk.onToggle}
          />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export const LocalWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const workspace = createMemo(() => {
    const [store, setStore] = serverSync().child(props.project.worktree)
    return { store, setStore }
  })
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const sessions = createMemo(() => sortedRootSessions(workspace().store, props.sortNow()))
  const active = createMemo(() => pathKey(props.ctx.currentDir()) === pathKey(props.project.worktree))
  const bulk = useWorkspaceBulk({
    directory: () => props.project.worktree,
    sessions,
    active,
    expanded: () => true,
  })
  const count = createMemo(() => sessions()?.length ?? 0)
  const fetching = useIsFetching(() => queryOptions().sessions(pathKey(props.project.worktree)))
  const hasMore = createMemo(() => workspace().store.sessionTotal > count())
  const loading = () => fetching() > 0 && count() === 0
  const loadMore = async () => {
    workspace().setStore("limit", (limit) => (limit ?? 0) + 5)
    await serverSync().project.loadSessions(props.project.worktree)
  }

  return (
    <div
      ref={(el) => props.ctx.setScrollContainerRef(el, props.mobile)}
      class="size-full flex flex-col py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]"
    >
      <SessionBulkBar
        selecting={bulk.store.selecting}
        count={bulk.store.selected.length}
        busy={bulk.store.busy}
        onToggleSelect={bulk.toggleSelect}
        onSelectAll={bulk.selectAll}
        onArchive={() => bulk.confirm("archive")}
        onDelete={() => bulk.confirm("delete")}
        onCancel={bulk.clearBulk}
        onCleanup={(id) => {
          void bulk.cleanup(id)
        }}
      />
      <WorkspaceSessionList
        slug={slug}
        mobile={props.mobile}
        ctx={props.ctx}
        showNew={() => false}
        loading={loading}
        sessions={sessions}
        hasMore={hasMore}
        loadMore={loadMore}
        language={language}
        selecting={bulk.store.selecting}
        selected={bulk.store.selected}
        locked={bulk.locked}
        onToggle={bulk.onToggle}
      />
    </div>
  )
}
