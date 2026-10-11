import { useDialog } from "@flynncode/ui/context/dialog"
import { Icon } from "@flynncode/ui/icon"
import { IconButtonV2 } from "@flynncode/ui/v2/icon-button-v2"
import { MenuV2 } from "@flynncode/ui/v2/menu-v2"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { createMemo, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { errorMessage } from "@/pages/layout/helpers"
import { listAllSessions } from "@/utils/session"
import { dismissToast, showToast } from "@/utils/toast"
import { worktreeMenuActions, type WorktreeMenuActionKey } from "./session-worktree-actions"
import { SessionWorktreeDialog, type WorktreeConfirmKind } from "./session-worktree-dialog"

// Worktree actions for the open session (legacy sidebar WorkspaceActions):
// handoff reuses the header's confirmation flow; reset and remove only apply
// to sandbox worktrees and always confirm first.
export function SessionWorktreeMenu(props: {
  directory: string
  root: string | undefined
  local: boolean
  sessionID: string | undefined
  handoffLabel: string
  onHandoff: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const tabs = useTabs()
  const [state, setState] = createStore({ busy: false })
  const actions = createMemo(() => worktreeMenuActions({ local: props.local, busy: state.busy, occupied: false }))
  const action = (key: WorktreeMenuActionKey) => actions().find((item) => item.key === key)

  const confirm = (kind: WorktreeConfirmKind) => {
    const root = props.root
    const directory = props.directory
    if (!root || !directory) return
    dialog.show(() => (
      <SessionWorktreeDialog
        kind={kind}
        directory={directory}
        onConfirm={() => void (kind === "remove" ? remove(root, directory) : reset(root, directory))}
      />
    ))
  }

  // Captures the server context up front: a removal navigates away, which can
  // unmount this header before the request settles.
  const remove = async (root: string, directory: string) => {
    const sdk = serverSDK()
    const sync = serverSync()
    const server = ServerConnection.key(sdk.server)
    const sessionID = props.sessionID
    setState("busy", true)
    const removed = await sdk.client.worktree
      .remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((result) => result.data)
      .catch((error: unknown) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(error, language.t("common.requestFailed")),
        })
        return false
      })
    setState("busy", false)
    if (!removed) return
    sync.set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    // The session's directory is gone, so leave it for a fresh draft in the
    // main checkout, as the legacy sidebar did.
    await tabs.newDraft({ server, directory: root })
    if (sessionID) tabs.removeSessionTab({ server, sessionId: sessionID })
  }

  const reset = async (root: string, directory: string) => {
    const sdk = serverSDK()
    const server = ServerConnection.key(sdk.server)
    setState("busy", true)
    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const sessions = await listAllSessions(sdk.api.session, { directory, order: "desc" }).then(
      (result) => result.sessions,
      () => [],
    )
    clearWorkspaceTerminals(
      directory,
      sessions.map((session) => session.id),
      platform,
      sdk.scope,
    )
    await sdk.client.instance.dispose({ directory }).catch(() => undefined)
    const result = await sdk.client.worktree
      .reset({ directory: root, worktreeResetInput: { directory } })
      .then((response) => response.data)
      .catch((error: unknown) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(error, language.t("common.requestFailed")),
        })
        return false
      })
    if (result && (await sdk.protocol) === "v1")
      await Promise.all(
        sessions
          .filter((session) => session.time.archived === undefined)
          .map((session) =>
            sdk.client.session
              .update({ sessionID: session.id, directory: session.directory, time: { archived: Date.now() } })
              .catch(() => undefined),
          ),
      )
    setState("busy", false)
    dismissToast(progress)
    if (!result) return
    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => void tabs.newDraft({ server, directory }),
        },
        { label: language.t("common.dismiss"), onClick: "dismiss" },
      ],
    })
  }

  return (
    <MenuV2 gutter={4} placement="bottom-end">
      <TooltipV2 class="shrink-0" placement="bottom" value={language.t("session.worktree.menu")}>
        <MenuV2.Trigger
          as={IconButtonV2}
          type="button"
          variant="ghost-muted"
          size="large"
          class="!w-9 shrink-0"
          data-action="session-worktree-menu"
          disabled={state.busy}
          aria-label={language.t("session.worktree.menu")}
          icon={<Icon name="branch" />}
        />
      </TooltipV2>
      <MenuV2.Portal>
        <MenuV2.Content>
          <Show when={action("session.worktree.handoff")}>
            {(item) => (
              <MenuV2.Item data-action="session-checkout-handoff" disabled={item().disabled} onSelect={props.onHandoff}>
                {props.handoffLabel}
              </MenuV2.Item>
            )}
          </Show>
          <Show when={action("session.worktree.reset")}>
            {(item) => (
              <>
                <MenuV2.Separator />
                <MenuV2.Item
                  data-action="session-worktree-reset"
                  disabled={item().disabled || !props.root}
                  onSelect={() => confirm("reset")}
                >
                  {language.t(item().key)}
                </MenuV2.Item>
              </>
            )}
          </Show>
          <Show when={action("session.worktree.remove")}>
            {(item) => (
              <MenuV2.Item
                data-action="session-worktree-remove"
                disabled={item().disabled || !props.root}
                onSelect={() => confirm("remove")}
              >
                {language.t(item().key)}
              </MenuV2.Item>
            )}
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
