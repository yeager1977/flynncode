import { useParams, useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createResource, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { Binary } from "@flynncode/core/util/binary"
import { base64Encode } from "@flynncode/core/util/encode"
import { getFilename } from "@flynncode/core/util/path"
import { Button } from "@flynncode/ui/button"
import { Collapsible } from "@flynncode/ui/collapsible"
import { useDialog } from "@flynncode/ui/context/dialog"
import { DropdownMenu } from "@flynncode/ui/dropdown-menu"
import { Icon } from "@flynncode/ui/icon"
import { IconButton } from "@flynncode/ui/icon-button"
import { IconButtonV2 } from "@flynncode/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@flynncode/ui/v2/icon"
import { Spinner } from "@flynncode/ui/spinner"
import { Tooltip } from "@flynncode/ui/tooltip"
import { type Session } from "@flynncode/sdk/v2/client"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync, useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { useDirectoryPicker } from "@/components/directory-picker"
import {
  localHandoffAction,
  worktreeMenuActions,
  type WorktreeMenuAction,
  type WorktreeMenuActionKey,
} from "@/components/session/session-worktree-actions"
import { foldersConnection, getSessionFolders, setSessionExtras, setSessionPrimary } from "@/utils/session-folders-api"
import { MaxSessionExtraFolders, normalizeSessionFolders, removeSessionFolder } from "@/components/session-folders"
import { listAllSessions, normalizeSessionInfo } from "@/utils/session"
import { showToast } from "@/utils/toast"
import {
  BULK_PRESETS,
  cleanupCandidates,
  confirmIDs,
  parentLinks,
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
import { sortedRootSessions, errorMessage, homeProjectDirectories } from "./helpers"
import { worktreeAllowPrimaryRebind } from "@/components/settings-v2/worktree-payload"
import { handoffErrorMessage, handoffFollowHref } from "../session/checkout-handoff"
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
  // Directory of the routed session or draft; undefined on Home.
  routedDir: Accessor<string | undefined>
  navList: Accessor<Session[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  sessionHref?: (session: { directory: string; id: string }) => string
  // Undefined when new sessions are not routes (the new layout opens draft tabs).
  newSessionHref: (directory: string) => string | undefined
  newSession: (directory: string) => void
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
  occupied: Accessor<boolean>
  localHandoff: Accessor<WorktreeMenuAction | undefined>
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
  onHandoffWorkspace: (directory: string) => void
  canHandoff: Accessor<boolean>
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
            <DropdownMenu.ItemLabel>{props.language.t("session.worktree.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("session.worktree.remove")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <Show
            when={worktreeMenuActions({
              local: props.local(),
              busy: props.busy(),
              occupied: props.occupied(),
              // Handing off needs a routed session or draft to move from.
              routed: props.canHandoff(),
            }).find((action) => action.key === "session.worktree.handoff")}
            keyed
          >
            {(action) => (
              <Tooltip
                value={action.disabledReason ? props.language.t(action.disabledReason) : props.language.t(action.key)}
                placement="right"
              >
                <DropdownMenu.Item
                  disabled={action.disabled}
                  onSelect={() => props.onHandoffWorkspace(props.directory)}
                >
                  <DropdownMenu.ItemLabel>{props.language.t(action.key)}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Tooltip>
            )}
          </Show>
          <Show when={props.localHandoff()} keyed>
            {(action) => (
              <Tooltip
                value={action.disabledReason ? props.language.t(action.disabledReason) : props.language.t(action.key)}
                placement="right"
              >
                <DropdownMenu.Item disabled={action.disabled} onSelect={() => props.onHandoffWorkspace(props.root)}>
                  <DropdownMenu.ItemLabel>{props.language.t(action.key)}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Tooltip>
            )}
          </Show>
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

const CLEANUP_SCAN_LIMIT = 10_000

// The menu model moved next to the new-layout session header; keep the
// export here for legacy callers.
export { worktreeMenuActions, type WorktreeMenuAction, type WorktreeMenuActionKey }

function mergeSessions(left: readonly Session[], right: readonly Session[]) {
  const byID = new Map<string, Session>()
  for (const session of left) byID.set(session.id, session)
  for (const session of right) byID.set(session.id, session)
  return [...byID.values()]
}

function CleanupConfirm(props: {
  count: number
  matchLabel: string
  skippedLabel?: string
  scopeLabel?: string
  busy: boolean
  onCancel: () => void
  onRun: (op: BulkOp) => void
}) {
  const [step, setStep] = createStore({ op: undefined as BulkOp | undefined })
  return (
    <Show
      when={step.op}
      fallback={
        <BulkConfirmDialog
          op="archive"
          count={props.count}
          matchLabel={props.matchLabel}
          skippedLabel={props.skippedLabel}
          scopeLabel={props.scopeLabel}
          busy={props.busy}
          onCancel={props.onCancel}
          onConfirm={() => {}}
          onArchive={() => setStep("op", "archive")}
          onDelete={() => setStep("op", "delete")}
        />
      }
    >
      {(op) => (
        <BulkConfirmDialog
          op={op()}
          count={props.count}
          matchLabel={props.matchLabel}
          skippedLabel={props.skippedLabel}
          scopeLabel={props.scopeLabel}
          busy={props.busy}
          onCancel={props.onCancel}
          onConfirm={() => props.onRun(op())}
        />
      )}
    </Show>
  )
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
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [bulk, setBulk] = createStore({
    selecting: false,
    selected: [] as string[],
    anchor: undefined as string | undefined,
    busy: false,
  })
  let generation = 0
  let confirmEpoch = 0
  let suppressDismiss = false
  let retained: readonly Session[] = []
  const marker = `bulk-${Math.random().toString(36).slice(2)}`
  const oursShowing = () => {
    if (typeof document === "undefined") return false
    const layers = document.querySelectorAll("[data-dialog-layer]")
    const top = layers.item(layers.length - 1)
    return !!top?.querySelector(`[data-bulk-confirm="${marker}"]`)
  }
  const invalidateConfirm = () => {
    generation += 1
    setBulk("busy", false)
  }
  const closeConfirm = () => {
    if (!oursShowing()) return
    dialog.close()
  }
  const showConfirm = (element: () => JSX.Element) => {
    const epoch = ++confirmEpoch
    if (oursShowing()) dialog.close()
    dialog.show(
      () => (
        <div data-bulk-confirm={marker} style={{ display: "contents" }}>
          {element()}
        </div>
      ),
      () => {
        if (epoch !== confirmEpoch) return
        if (suppressDismiss) return
        invalidateConfirm()
      },
    )
  }
  const dismissConfirm = () => {
    invalidateConfirm()
    closeConfirm()
  }
  const clearBulk = () => {
    generation += 1
    retained = []
    closeConfirm()
    setBulk({ selecting: false, selected: [], anchor: undefined, busy: false })
  }
  const knownFor = (directory: string) => serverSync().child(directory, { bootstrap: false })[0].session ?? []
  const known = () => knownFor(input.directory())
  const pending = (id: string) => {
    const data = serverSync().session.data
    return (data.permission[id]?.length ?? 0) > 0 || (data.question[id]?.length ?? 0) > 0
  }
  const parentLinkMap = () => {
    const sync = serverSync()
    const data = sync.session.data
    const ids = new Set<string>()
    if (params.id) ids.add(params.id)
    for (const id of Object.keys(data.session_status)) {
      if (data.session_working(id)) ids.add(id)
    }
    for (const [id, items] of Object.entries(data.permission)) {
      if ((items?.length ?? 0) > 0) ids.add(id)
    }
    for (const [id, items] of Object.entries(data.question)) {
      if ((items?.length ?? 0) > 0) ids.add(id)
    }
    return parentLinks(ids, (id) => sync.session.peek(id)?.parentID)
  }
  const blockedFor = (list: readonly Session[]) =>
    protectedRootIDs(list, {
      openRouteID: params.id,
      working: (id) => serverSync().session.data.session_working(id),
      pending,
      parentID: parentLinkMap(),
    })
  const allowed = createMemo(() => {
    const blocked = blockedFor(known())
    return new Set(
      input
        .sessions()
        .map((session) => session.id)
        .filter((id) => !blocked.has(id)),
    )
  })
  const forget = (id: string, directory: string) => {
    const [, setStore] = serverSync().child(directory, { bootstrap: false })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, id, (item) => item.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    serverSync().homeSessions.remove(id)
    notifySessionTabsRemoved({ directory, sessionIDs: [id] })
  }
  const archiveOne = async (sessionID: string, directory: string) => {
    const archived = Date.now()
    await serverSDK().client.session.update({ sessionID, directory, time: { archived } })
    forget(sessionID, directory)
  }
  const removeOne = async (sessionID: string, directory: string) => {
    await serverSDK().api.session.remove({ sessionID })
    forget(sessionID, directory)
  }
  const protectedNow = (id: string, directory: string, extra: readonly Session[]) => {
    const list = mergeSessions(knownFor(directory), extra)
    if (params.id === id) return true
    if (serverSync().session.data.session_working(id)) return true
    if (pending(id)) return true
    return blockedFor(list).has(id)
  }
  const run = async (
    op: BulkOp,
    ids: readonly string[],
    extra: readonly Session[],
    directory: string,
    ticket: number,
  ) => {
    if (ticket !== generation) return
    if (bulk.busy) return
    setBulk("busy", true)
    suppressDismiss = true
    closeConfirm()
    suppressDismiss = false
    const result = await runSessionBulk({
      ids,
      op,
      isProtected: (id) => {
        if (ticket !== generation) throw new Error("cancelled")
        return protectedNow(id, directory, extra)
      },
      archive: async (id) => {
        if (ticket !== generation) throw new Error("cancelled")
        await archiveOne(id, directory)
      },
      remove: async (id) => {
        if (ticket !== generation) throw new Error("cancelled")
        await removeOne(id, directory)
      },
    })
    if (ticket !== generation) {
      setBulk("busy", false)
      return
    }
    if (result.failed) {
      retained = extra
      // Protected-after-confirm sessions were skipped, not failed; count them
      // in the same not-changed total so the toast matches the dialog count.
      const unchanged = result.pending.length + result.skipped.length + 1
      showToast({
        title: language.plural("session.bulk.failed", unchanged),
        ...(result.skipped.length > 0
          ? { description: language.plural("session.bulk.cleanup.skipped", result.skipped.length) }
          : {}),
      })
      setBulk({
        selecting: true,
        selected: [result.failed, ...result.pending, ...result.skipped],
        anchor: result.failed,
        busy: false,
      })
      return
    }
    clearBulk()
  }
  const confirm = (op: BulkOp) => {
    if (bulk.busy) return
    const ticket = generation
    const directory = input.directory()
    const loaded = new Set(input.sessions().map((session) => session.id))
    const ids = confirmIDs(bulk.selected, loaded, allowed(), blockedFor(known()))
    if (ids.length === 0) return
    const frozen = [...ids]
    const extra = mergeSessions(knownFor(directory), retained)
    showConfirm(() => (
      <BulkConfirmDialog
        op={op}
        count={frozen.length}
        busy={bulk.busy}
        onCancel={dismissConfirm}
        onConfirm={() => {
          void run(op, frozen, extra, directory, ticket)
        }}
      />
    ))
  }
  const cleanup = async (id: BulkPreset) => {
    if (bulk.busy) return
    const ticket = generation
    const directory = input.directory()
    setBulk("busy", true)
    const page = await serverSDK()
      .api.session.list({
        directory,
        order: "desc",
        limit: CLEANUP_SCAN_LIMIT,
      })
      .catch(() => undefined)
    if (ticket !== generation || input.directory() !== directory) {
      setBulk("busy", false)
      return
    }
    if (!page) {
      setBulk("busy", false)
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    // Exact-limit pages can still be a complete scan — only bail when a
    // next cursor exists; listAllSessions bounds the recursion and reports
    // truncation itself.
    const fetchedAll = page.cursor.next
      ? await listAllSessions(serverSDK().api.session, {
          directory,
          order: "desc",
          limit: CLEANUP_SCAN_LIMIT,
        }).catch(() => undefined)
      : { sessions: page.data.map(normalizeSessionInfo), truncated: false }
    setBulk("busy", false)
    if (!fetchedAll) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    if (ticket !== generation || input.directory() !== directory) return
    const fetched = fetchedAll.sessions
    const truncated = fetchedAll.truncated
    const now = Date.now()
    const extra = mergeSessions(knownFor(directory), fetched)
    const found = cleanupCandidates(fetched, now, presetDays(id), blockedFor(extra))
    if (found.match.length === 0) {
      if (!truncated) {
        showConfirm(() => (
          <BulkConfirmDialog
            op="archive"
            count={0}
            empty
            busy={bulk.busy}
            onCancel={dismissConfirm}
            onConfirm={() => {}}
          />
        ))
      } else {
        showToast({ title: language.t("session.bulk.cleanup.truncated") })
      }
      return
    }
    if (truncated) showToast({ title: language.t("session.bulk.cleanup.truncated") })
    const ids = found.match.map((session) => session.id)
    const period = language.t(`session.bulk.period.${id}`)
    const matchLabel = language.plural("session.bulk.cleanup.match", found.match.length, { period })
    const skippedLabel =
      found.skipped.length > 0 ? language.plural("session.bulk.cleanup.skipped", found.skipped.length) : undefined
    showConfirm(() => (
      <CleanupConfirm
        count={ids.length}
        matchLabel={matchLabel}
        skippedLabel={skippedLabel}
        busy={bulk.busy}
        onCancel={dismissConfirm}
        onRun={(op) => {
          void run(op, ids, extra, directory, ticket)
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
    const loaded = input.sessions().map((session) => session.id)
    const loadedIDs = new Set(loaded)
    setBulk("selected", [...selectLoaded(loaded, allowed()), ...bulk.selected.filter((id) => !loadedIDs.has(id))])
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
      if (oursShowing()) return
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
    closeConfirm()
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
  directory: string
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
        href={props.ctx.newSessionHref(props.directory)}
        onSelect={() => props.ctx.newSession(props.directory)}
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
          href={props.ctx.sessionHref}
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

// Multifold: folder list for the open session. The primary folder owns Git,
// AGENTS.md, and config; extras only widen file access. Switching primary
// reboots the instance via the instance folders route.
function WorkspaceFolders(props: { directory: string }) {
  const params = useParams()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const pickDirectory = useDirectoryPicker()
  const sessionID = createMemo(() => params.id as string | undefined)
  const conn = createMemo(() => foldersConnection(server.current, platform.fetch))
  const [folders, { refetch }] = createResource(sessionID, (id) => {
    const connection = conn()
    if (!connection) return Promise.resolve(undefined)
    return getSessionFolders(connection, id)
  })
  const attached = createMemo(() => {
    const data = folders()
    if (!data || data.primary !== props.directory) return undefined
    return { primary: data.primary, extras: normalizeSessionFolders(data.primary, data.extras) }
  })

  const updateExtras = async (extras: string[]) => {
    const id = sessionID()
    const connection = conn()
    if (!id || !connection) return
    const updated = await setSessionExtras(connection, id, extras)
    if (!updated) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    showToast({ title: language.t("toast.folders.updated") })
    await refetch()
  }

  const setPrimary = async (next: string) => {
    const id = sessionID()
    const connection = conn()
    if (!id || !connection) return
    const updated = await setSessionPrimary(connection, id, props.directory, next)
    if (!updated) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    showToast({ title: language.t("toast.folders.updated") })
    await refetch()
  }

  const add = () => {
    const conn = server.current
    const data = attached()
    if (!conn || !data) return
    pickDirectory({
      server: conn,
      title: language.t("session.folders.add"),
      multiple: true,
      onSelect: (result) => {
        const known = [data.primary, ...data.extras]
        const fresh = homeProjectDirectories(result).filter((directory) => {
          if (known.includes(directory)) {
            showToast({ title: language.t("session.folders.duplicate") })
            return false
          }
          return true
        })
        if (fresh.length === 0) return
        if (data.extras.length + fresh.length > MaxSessionExtraFolders) {
          showToast({ title: language.t("session.folders.limit", { max: MaxSessionExtraFolders }) })
          return
        }
        void updateExtras([...data.extras, ...fresh])
      },
    })
  }

  return (
    <Show when={attached()} keyed>
      {(data) => (
        <div class="flex flex-col gap-1 px-2 py-1">
          <span class="text-12-regular text-text-weak">{language.t("session.folders.title")}</span>
          <span class="text-12-regular text-text-weak">{language.t("session.folders.primaryNote")}</span>
          <For each={[data.primary, ...data.extras]}>
            {(directory, index) => (
              <div class="flex min-w-0 items-center gap-1">
                <span class="text-14-regular text-text-base min-w-0 flex-1 truncate">{directory}</span>
                <Show
                  when={index() === 0}
                  fallback={
                    <>
                      <button
                        type="button"
                        class="text-12-regular text-text-weak underline"
                        onClick={() => void setPrimary(directory)}
                      >
                        {language.t("session.folders.setPrimary")}
                      </button>
                      <button
                        type="button"
                        class="text-12-regular text-text-weak underline"
                        aria-label={language.t("session.folders.remove")}
                        onClick={() => void updateExtras(removeSessionFolder(data.extras, directory))}
                      >
                        {language.t("session.folders.remove")}
                      </button>
                    </>
                  }
                >
                  <span class="text-12-regular text-text-weak">{language.t("session.folders.primary")}</span>
                </Show>
              </div>
            )}
          </For>
          <button type="button" class="text-12-regular text-text-weak self-start underline" onClick={add}>
            {language.t("session.folders.add")}
          </button>
        </div>
      )}
    </Show>
  )
}

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
  // Load only the session list unless this directory is routed (the new session sidebar).
  listOnly?: boolean
}): JSX.Element => {
  const params = useParams()
  const navigate = useNavigate()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
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
  const active = createMemo(() => pathKey(props.ctx.routedDir() ?? "") === pathKey(props.directory))
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
  // Occupied guard uses loaded sessions only (no new server state): handing
  // off into a workspace that already backs an active session is disabled.
  const occupied = createMemo(() => {
    if (pathKey(props.ctx.routedDir() ?? "") === pathKey(props.directory)) return false
    return (workspaceStore.session ?? []).some((item) => item.time?.archived == null)
  })
  // The Local checkout as a handoff target is opt-in through
  // worktree.allow_primary_rebind; its occupied guard counts the local
  // workspace's loaded sessions the same way the worktree guard does.
  const [localStore] = serverSync().child(props.project.worktree, { bootstrap: false })
  const localOccupied = createMemo(() => (localStore.session ?? []).some((item) => item.time?.archived == null))
  const localHandoff = createMemo(() =>
    localHandoffAction({
      allow: worktreeAllowPrimaryRebind(serverSync().data.config),
      busy: busy(),
      occupied: localOccupied(),
      routed: !!props.ctx.routedDir(),
      localRouted: pathKey(props.ctx.routedDir() ?? "") === pathKey(props.project.worktree),
    }),
  )
  const handoffTo = (target: string) => {
    const from = props.ctx.routedDir()
    if (!from) return
    void serverSDK()
      .client.worktree.handoff({ directory: props.project.worktree, worktreeHandoffInput: { from, to: target } })
      .then(async (result) => {
        if (!result.data) {
          showToast({
            title: language.t("session.handoff.failed.title"),
            description: language.t("session.handoff.failed.description", {
              message: language.t("common.requestFailed"),
            }),
          })
          return
        }
        // The rebound session rows now live in the target; bootstrap the
        // destination workspace and follow the routed session there when its
        // row actually moved (a refused rebind keeps it on its checkout, and
        // the legacy host recreates the directory-scoped client on navigate).
        serverSync().child(target, { bootstrap: true })
        const id = params.id
        if (!id) return
        const rowDirectory = await serverSDK()
          .client.session.get({ sessionID: id, directory: target })
          .then((response) => response.data?.directory)
          .catch(() => undefined)
        const href = handoffFollowHref({
          sessionID: id,
          rowDirectory,
          target,
          href: props.ctx.sessionHref,
        })
        if (href) navigate(href)
      })
      .catch((error: unknown) => {
        showToast({
          title: language.t("session.handoff.failed.title"),
          description: language.t("session.handoff.failed.description", {
            message: handoffErrorMessage(error) ?? errorMessage(error, language.t("common.requestFailed")),
          }),
        })
      })
  }
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
    if (props.listOnly && !active()) {
      if (open()) void serverSync().project.loadSessions(props.directory)
      return
    }
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
                occupied={occupied}
                localHandoff={localHandoff}
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
                onHandoffWorkspace={handoffTo}
                canHandoff={() => !!props.ctx.routedDir()}
                root={props.project.worktree}
                clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                navigateToNewSession={() => props.ctx.newSession(props.directory)}
              />
            </div>
          </div>
        </div>

        <Collapsible.Content>
          <WorkspaceFolders directory={props.directory} />
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
            directory={props.directory}
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
  // Rendered inside a parent that scrolls, so this list neither scrolls nor registers the scroll ref.
  inline?: boolean
  // Load only the session list unless the routed session or draft is in this
  // project (the new session sidebar), instead of bootstrapping every project.
  listOnly?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const queryOptions = useQueryOptions()
  const language = useLanguage()
  const routedHere = createMemo(() => {
    const directory = props.ctx.routedDir()
    if (!directory) return false
    const key = pathKey(directory)
    return [props.project.worktree, ...(props.project.sandboxes ?? [])].some((item) => pathKey(item) === key)
  })
  const bootstrap = createMemo(() => !props.listOnly || routedHere())
  const workspace = createMemo(() => {
    const [store, setStore] = serverSync().child(props.project.worktree, { bootstrap: bootstrap() })
    return { store, setStore }
  })
  createEffect(() => {
    if (bootstrap()) return
    void serverSync().project.loadSessions(props.project.worktree)
  })
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const sessions = createMemo(() => sortedRootSessions(workspace().store, props.sortNow()))
  const active = createMemo(() => pathKey(props.ctx.routedDir() ?? "") === pathKey(props.project.worktree))
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
      ref={(el) => {
        if (!props.inline) props.ctx.setScrollContainerRef(el, props.mobile)
      }}
      class="flex flex-col"
      classList={{ "size-full py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]": !props.inline }}
    >
      <WorkspaceFolders directory={props.project.worktree} />
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
        directory={props.project.worktree}
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
