import { A } from "@solidjs/router"
import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { base64Encode } from "@flynncode/core/util/encode"
import { getFilename } from "@flynncode/core/util/path"
import { Icon as IconV2 } from "@flynncode/ui/v2/icon"
import { Icon } from "@flynncode/ui/icon"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import {
  artifactTargetHref,
  artifactVersionSignal,
  filterArtifactGroups,
  groupSessionArtifacts,
  loadArtifactFilter,
  loadStoredArtifacts,
  saveArtifactFilter,
  type Artifact,
  type ArtifactFilter,
  type ArtifactGroup,
} from "./sidebar-artifacts"

const FILTERS = [
  { id: "all", label: "sidebar.artifacts.filter.all" },
  { id: "changed", label: "sidebar.artifacts.filter.changed" },
  { id: "screenshots", label: "sidebar.artifacts.filter.screenshots" },
  { id: "notes", label: "sidebar.artifacts.filter.notes" },
] as const satisfies readonly { id: ArtifactFilter; label: string }[]

const artifactIcon = (artifact: Artifact) => {
  if (artifact.type === "screenshot") return "photo"
  if (artifact.type === "note") return "comment"
  return "file-tree"
}

const artifactLabel = (artifact: Artifact) => {
  if (artifact.type === "diff" || artifact.type === "file") return getFilename(artifact.file)
  if (artifact.type === "screenshot") return artifact.note ?? artifact.url
  return artifact.text
}

const ArtifactRow = (props: {
  group: ArtifactGroup
  artifact: Artifact
  path: string
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const href = createMemo(() => artifactTargetHref(props.path, props.artifact))
  return (
    <A
      href={href()}
      class="flex items-center gap-2 min-w-0 w-full text-left focus:outline-none py-0.5"
      onClick={() => {
        if (props.sidebarExpanded()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <Show
          when={props.artifact.type === "screenshot" ? props.artifact.thumbnail : undefined}
          fallback={<Icon name={artifactIcon(props.artifact)} size="small" class="text-icon-base" />}
        >
          {(thumbnail) => <img src={thumbnail()} alt="" class="size-6 rounded-sm object-cover" />}
        </Show>
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{artifactLabel(props.artifact)}</span>
      <span class="text-12-regular text-text-weak shrink-0" title={artifactLabel(props.artifact)}>
        {getRelativeTime(new Date(props.group.updated).toISOString(), props.language.t)}
      </span>
    </A>
  )
}

const ArtifactSessionGroup = (props: {
  group: ArtifactGroup
  path: string
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const href = props.path
  const label = createMemo(() => sessionTitle(props.group.title) || props.language.t("command.session.new"))
  const close = () => {
    if (props.sidebarExpanded()) return
    props.clearHoverProjectSoon()
  }
  return (
    <div class="flex flex-col gap-0.5">
      <A
        href={href}
        class="flex items-center gap-1 min-w-0 text-left focus:outline-none py-0.5"
        onClick={close}
      >
        <span class="text-12-medium text-text-weak min-w-0 flex-1 truncate">{label()}</span>
        <span class="text-12-regular text-text-weak shrink-0">{props.group.artifacts.length}</span>
      </A>
      <For each={props.group.artifacts}>
        {(artifact) => (
          <ArtifactRow
            group={props.group}
            artifact={artifact}
            path={props.path}
            sidebarExpanded={props.sidebarExpanded}
            clearHoverProjectSoon={props.clearHoverProjectSoon}
            language={props.language}
          />
        )}
      </For>
    </div>
  )
}

export const SidebarArtifacts = (props: {
  directory: Accessor<string | undefined>
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  // Session route for a group; defaults to the classic `/:dir/session/:id`.
  sessionPath?: (sessionID: string) => string | undefined
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [filter, setFilterState] = createSignal<ArtifactFilter>(loadArtifactFilter())
  const setFilter = (next: ArtifactFilter) => {
    saveArtifactFilter(next)
    setFilterState(next)
  }
  const slug = createMemo(() => {
    const dir = props.directory()
    if (!dir) return ""
    return base64Encode(dir)
  })
  const groups = createMemo(() => {
    const dir = props.directory()
    if (!dir) return []
    // Track the store version so a freshly stored screenshot or note shows up
    // reactively; localStorage itself is read non-reactively per directory.
    artifactVersionSignal()
    const [store] = serverSync().child(dir, { bootstrap: false })
    return groupSessionArtifacts(store, pathKey(dir) ?? dir, loadStoredArtifacts(dir))
  })
  const filtered = createMemo(() => filterArtifactGroups(groups(), filter()))
  const count = createMemo(() => groups().reduce((total, group) => total + group.artifacts.length, 0))

  return (
    <Show when={groups().length > 0}>
      <div class="shrink-0 flex flex-col" data-component="sidebar-artifacts">
        <button
          type="button"
          class="flex items-center gap-1 w-full py-1.5 pl-2 pr-2 rounded-md hover:bg-surface-raised-base-hover transition-colors focus:outline-none"
          data-action="sidebar-artifacts-toggle"
          aria-expanded={open()}
          aria-label={language.t("sidebar.artifacts.toggle")}
          onClick={() => setOpen(!open())}
        >
          <div class="flex items-center justify-center shrink-0 size-6">
            <IconV2 name="review" size="small" class="text-icon-base" />
          </div>
          <span class="text-14-medium text-text-base min-w-0 flex-1 truncate text-start">
            {language.t("sidebar.artifacts.title")}
          </span>
          <span class="text-12-medium text-text-weak shrink-0">{count()}</span>
          <div class="flex items-center justify-center shrink-0 size-6">
            <IconV2 name={open() ? "chevron-down" : "collapse"} size="small" class="text-icon-base" />
          </div>
        </button>
        <Show when={open()}>
          <div class="flex flex-col gap-2 pb-1">
            <div class="flex items-center gap-1 px-2" data-action="sidebar-artifacts-filter">
              <For each={FILTERS}>
                {(item) => (
                  <button
                    type="button"
                    class="px-1.5 py-0.5 rounded-md text-12-medium transition-colors focus:outline-none"
                    classList={{
                      "bg-surface-raised-base-active text-text-strong": filter() === item.id,
                      "text-text-weak hover:bg-surface-raised-base-hover": filter() !== item.id,
                    }}
                    aria-pressed={filter() === item.id}
                    data-filter={item.id}
                    onClick={() => setFilter(item.id)}
                  >
                    {language.t(item.label)}
                  </button>
                )}
              </For>
            </div>
            <For each={filtered()}>
              {(group) => (
                <ArtifactSessionGroup
                  group={group}
                  path={props.sessionPath?.(group.sessionID) ?? `/${slug()}/session/${group.sessionID}`}
                  sidebarExpanded={props.sidebarExpanded}
                  clearHoverProjectSoon={props.clearHoverProjectSoon}
                  language={language}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
