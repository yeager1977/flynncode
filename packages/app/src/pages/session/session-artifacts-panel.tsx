import { getFilename } from "@opencode-ai/core/util/path"
import { Icon } from "@opencode-ai/ui/icon"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { A } from "@solidjs/router"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
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
} from "@/pages/layout/sidebar-artifacts"
import { sessionHref } from "@/utils/session-route"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"

const FILTERS = [
  { id: "all", label: "sidebar.artifacts.filter.all" },
  { id: "changed", label: "sidebar.artifacts.filter.changed" },
  { id: "screenshots", label: "sidebar.artifacts.filter.screenshots" },
  { id: "notes", label: "sidebar.artifacts.filter.notes" },
] as const satisfies readonly { id: ArtifactFilter; label: string }[]

// Artifacts produced by this workspace's sessions (changed files, browser
// screenshots, notes), grouped per session — the legacy sidebar's "Changed
// files" section. Diffs come from the server-wide session cache and stored
// screenshots/notes from local storage, so the list is reactive to both.
export function createSessionArtifacts() {
  const sdk = useSDK()
  const sync = useSync()
  const groups = createMemo(() => {
    artifactVersionSignal()
    const directory = sdk().directory
    return groupSessionArtifacts(
      { session: sync().data.session, session_diff: sync().data.session_diff },
      directory,
      loadStoredArtifacts(directory),
    )
  })
  return {
    groups,
    count: createMemo(() => groups().reduce((total, group) => total + group.artifacts.length, 0)),
  }
}

export function SessionArtifactsPanel(props: { groups: ArtifactGroup[] }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [filter, setFilter] = createSignal<ArtifactFilter>(loadArtifactFilter())
  const filtered = createMemo(() => filterArtifactGroups(props.groups, filter()))
  const base = (sessionID: string) => sessionHref(ServerConnection.key(serverSDK().server), sessionID)

  return (
    <div data-component="session-artifacts" class="flex flex-col gap-3 pt-3 pb-3 text-[13px] leading-5">
      <SegmentedControlV2
        value={filter()}
        aria-label={language.t("session.artifacts.tab")}
        onChange={(value) => {
          if (value !== "all" && value !== "changed" && value !== "screenshots" && value !== "notes") return
          saveArtifactFilter(value)
          setFilter(value)
        }}
      >
        <For each={FILTERS}>
          {(item) => (
            <SegmentedControlItemV2 value={item.id} data-filter={item.id}>
              {language.t(item.label)}
            </SegmentedControlItemV2>
          )}
        </For>
      </SegmentedControlV2>
      <Show
        when={filtered().length > 0}
        fallback={<span class="text-v2-text-text-muted">{language.t("session.artifacts.emptyFilter")}</span>}
      >
        <For each={filtered()}>
          {(group) => (
            <div class="flex flex-col gap-0.5">
              <A
                href={base(group.sessionID)}
                class="flex min-w-0 items-center gap-1 rounded-[6px] py-0.5 text-v2-text-text-muted hover:text-v2-text-text-base focus:outline-none"
              >
                <span class="min-w-0 flex-1 truncate">
                  {sessionTitle(group.title) || language.t("command.session.new")}
                </span>
                <span class="shrink-0">{group.artifacts.length}</span>
              </A>
              <For each={group.artifacts}>
                {(artifact) => (
                  <A
                    href={artifactTargetHref(base(group.sessionID), artifact)}
                    class="flex min-w-0 items-center gap-2 rounded-[6px] py-0.5 hover:bg-v2-overlay-simple-overlay-hover focus:outline-none"
                  >
                    <span class="flex size-6 shrink-0 items-center justify-center">
                      <Show
                        when={artifact.type === "screenshot" ? artifact.thumbnail : undefined}
                        fallback={<Icon name={artifactIcon(artifact)} size="small" class="text-icon-base" />}
                      >
                        {(thumbnail) => <img src={thumbnail()} alt="" class="size-6 rounded-sm object-cover" />}
                      </Show>
                    </span>
                    <span class="min-w-0 flex-1 truncate text-v2-text-text-base" title={artifactLabel(artifact)}>
                      {artifactLabel(artifact)}
                    </span>
                    <span class="shrink-0 text-v2-text-text-faint">
                      {getRelativeTime(new Date(group.updated).toISOString(), language.t)}
                    </span>
                  </A>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function artifactIcon(artifact: Artifact) {
  if (artifact.type === "screenshot") return "photo"
  if (artifact.type === "note") return "comment"
  return "file-tree"
}

function artifactLabel(artifact: Artifact) {
  if (artifact.type === "diff" || artifact.type === "file") return getFilename(artifact.file)
  if (artifact.type === "screenshot") return artifact.note ?? artifact.url
  return artifact.text
}
