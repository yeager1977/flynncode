import { Popover } from "@opencode-ai/ui/popover"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useDirectoryPicker } from "@/components/directory-picker"
import {
  appendSessionFolders,
  MaxSessionExtraFolders,
  normalizeSessionFolders,
  removeSessionFolder,
} from "@/components/session-folders"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { homeProjectDirectories } from "@/pages/layout/helpers"
import {
  foldersConnection,
  getSessionFolders,
  setSessionExtras,
  setSessionPrimary,
  type FoldersConnection,
  type SessionFolders,
} from "@/utils/session-folders-api"
import { showToast } from "@/utils/toast"

// Multifold folders for an open session, behind a header icon. The primary
// folder owns Git, AGENTS.md, and config; extras only widen file access.
// Switching primary reboots the instance and rebinds the session directory.
export function SessionFoldersMenu(props: { sessionID: string; directory: string }) {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const pickDirectory = useDirectoryPicker()
  const [state, setState] = createStore({ open: false, busy: false })
  const conn = createMemo(() => foldersConnection(serverSDK().server, platform.fetch))
  // Fetch on every open so folders changed elsewhere (another window, the
  // new-session view) show up without a stale cache.
  const [folders, { mutate }] = createResource(
    () => (state.open ? props.sessionID : undefined),
    (sessionID) => {
      const connection = conn()
      if (!connection) return Promise.resolve(undefined)
      return getSessionFolders(connection, sessionID)
    },
  )
  const list = createMemo(() => {
    const data = folders()
    if (!data) return
    return { primary: data.primary, extras: normalizeSessionFolders(data.primary, data.extras) }
  })

  const apply = async (request: (connection: FoldersConnection) => Promise<SessionFolders | undefined>) => {
    const connection = conn()
    if (!connection || state.busy) return
    setState("busy", true)
    const updated = await request(connection)
    setState("busy", false)
    if (!updated) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    mutate(updated)
    showToast({ title: language.t("toast.folders.updated") })
  }

  const add = () => {
    const data = list()
    if (!data) return
    setState("open", false)
    pickDirectory({
      server: serverSDK().server,
      title: language.t("session.folders.add"),
      multiple: true,
      onSelect: (result) => {
        const plan = appendSessionFolders(data.primary, data.extras, homeProjectDirectories(result))
        if (plan.duplicate) showToast({ title: language.t("session.folders.duplicate") })
        if (plan.added === 0) return
        if (plan.overLimit) {
          showToast({ title: language.t("session.folders.limit", { max: MaxSessionExtraFolders }) })
          return
        }
        void apply((connection) => setSessionExtras(connection, props.sessionID, plan.extras))
      },
    })
  }

  return (
    <TooltipV2 class="shrink-0" placement="bottom" value={language.t("session.folders.title")}>
      <Popover
        open={state.open}
        onOpenChange={(open) => setState("open", open)}
        triggerAs={IconButtonV2}
        triggerProps={{
          variant: "ghost-muted",
          size: "large",
          class: "!w-9 shrink-0",
          state: state.open ? "pressed" : undefined,
          "aria-label": language.t("session.folders.title"),
          "data-action": "session-folders-menu",
        }}
        trigger={<IconV2 name="folder" />}
        title={language.t("session.folders.title")}
        class="w-[360px] max-w-[calc(100vw-40px)]"
        gutter={4}
        placement="bottom-end"
      >
        <div data-component="session-folders" class="flex flex-col gap-2 text-[13px] leading-5">
          <span class="text-v2-text-text-faint">{language.t("session.folders.primaryNote")}</span>
          <Switch>
            <Match when={list()}>
              {(data) => (
                <div class="flex flex-col gap-1">
                  <For each={[data().primary, ...data().extras]}>
                    {(directory, index) => (
                      <div class="flex min-w-0 items-center gap-1" data-folder={directory}>
                        <span class="min-w-0 flex-1 truncate text-v2-text-text-base" title={directory}>
                          {directory}
                        </span>
                        <Show
                          when={index() > 0}
                          fallback={<Tag class="shrink-0">{language.t("session.folders.primary")}</Tag>}
                        >
                          <ButtonV2
                            data-action="session-folder-primary"
                            variant="ghost-muted"
                            size="small"
                            class="shrink-0"
                            disabled={state.busy}
                            onClick={() =>
                              void apply((connection) =>
                                setSessionPrimary(connection, props.sessionID, props.directory, directory),
                              )
                            }
                          >
                            {language.t("session.folders.setPrimary")}
                          </ButtonV2>
                          <TooltipV2 placement="top" value={language.t("session.folders.remove")} class="shrink-0">
                            <IconButtonV2
                              type="button"
                              data-action="session-folder-remove"
                              variant="ghost-muted"
                              size="small"
                              disabled={state.busy}
                              icon={<IconV2 name="xmark-small" />}
                              aria-label={language.t("session.folders.remove")}
                              onClick={() =>
                                void apply((connection) =>
                                  setSessionExtras(
                                    connection,
                                    props.sessionID,
                                    removeSessionFolder(data().extras, directory),
                                  ),
                                )
                              }
                            />
                          </TooltipV2>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Match>
            <Match when={folders.loading}>
              <span class="text-v2-text-text-muted">
                {language.t("common.loading")}
                {language.t("common.loading.ellipsis")}
              </span>
            </Match>
            <Match when={true}>
              <span class="text-v2-text-text-muted">{language.t("common.requestFailed")}</span>
            </Match>
          </Switch>
          <ButtonV2
            data-action="session-folder-add"
            variant="ghost-muted"
            size="small"
            icon="folder-add-left"
            class="self-start"
            disabled={state.busy || !list()}
            onClick={add}
          >
            {language.t("session.folders.add")}
          </ButtonV2>
        </div>
      </Popover>
    </TooltipV2>
  )
}
