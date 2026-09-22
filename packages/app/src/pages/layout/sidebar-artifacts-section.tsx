import { A, useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Icon } from "@opencode-ai/ui/icon"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { groupSessionArtifacts, type ArtifactGroup } from "./sidebar-artifacts"

const ArtifactRow = (props: {
  group: ArtifactGroup
  file: ArtifactGroup["files"][number]
  slug: string
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const href = `/${props.slug}/session/${props.group.sessionID}`
  return (
    <A
      href={href}
      class="flex items-center gap-2 min-w-0 w-full text-left focus:outline-none py-0.5"
      onClick={() => {
        if (props.sidebarExpanded()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <Icon name="file-tree" size="small" class="text-icon-base" />
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{getFilename(props.file.file)}</span>
      <span class="text-12-regular text-text-weak shrink-0" title={props.file.file}>
        {getRelativeTime(new Date(props.group.updated).toISOString(), props.language.t)}
      </span>
    </A>
  )
}

const ArtifactSessionGroup = (props: {
  group: ArtifactGroup
  slug: string
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const href = `/${props.slug}/session/${props.group.sessionID}`
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
        <span class="text-12-regular text-text-weak shrink-0">{props.group.files.length}</span>
      </A>
      <For each={props.group.files}>
        {(file) => (
          <ArtifactRow
            group={props.group}
            file={file}
            slug={props.slug}
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
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const slug = createMemo(() => {
    const dir = props.directory()
    if (!dir) return ""
    return base64Encode(dir)
  })
  const groups = createMemo(() => {
    const dir = props.directory()
    if (!dir) return []
    const [store] = serverSync().child(dir, { bootstrap: false })
    return groupSessionArtifacts(store, pathKey(dir) ?? dir)
  })
  const count = createMemo(() => groups().reduce((total, group) => total + group.files.length, 0))

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
            <For each={groups()}>
              {(group) => (
                <ArtifactSessionGroup
                  group={group}
                  slug={slug()}
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