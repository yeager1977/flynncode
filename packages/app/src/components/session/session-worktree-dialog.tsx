import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { listAllSessions } from "@/utils/session"

export type WorktreeConfirmKind = "reset" | "remove"

// Confirms a destructive worktree action, checking the worktree's git status
// (and, for reset, how many active sessions get archived) before enabling it.
export function SessionWorktreeDialog(props: { kind: WorktreeConfirmKind; directory: string; onConfirm: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({
    status: "loading" as "loading" | "ready" | "error",
    dirty: false,
    archived: 0,
  })

  onMount(() => {
    const sdk = serverSDK()
    void sdk.api.vcs
      .status({ location: { directory: props.directory } })
      .then((result) => setState({ status: "ready", dirty: result.data.length > 0 }))
      .catch(() => setState({ status: "error", dirty: false }))
    if (props.kind !== "reset") return
    void listAllSessions(sdk.api.session, { directory: props.directory, order: "desc" })
      .then((result) => setState("archived", result.sessions.filter((session) => session.time.archived === undefined).length))
      .catch(() => undefined)
  })

  const name = () => getFilename(props.directory)
  const status = () => {
    if (state.status === "loading") return language.t("workspace.status.checking")
    if (state.status === "error") return language.t("workspace.status.error")
    if (!state.dirty) return language.t("workspace.status.clean")
    return language.t("workspace.status.dirty")
  }
  const archived = () => {
    if (state.archived === 0) return language.t("workspace.reset.archived.none")
    if (state.archived === 1) return language.t("workspace.reset.archived.one")
    return language.t("workspace.reset.archived.many", { count: state.archived })
  }

  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t(props.kind === "remove" ? "workspace.delete.title" : "workspace.reset.title")}
          description={language.t(props.kind === "remove" ? "workspace.delete.confirm" : "workspace.reset.confirm", {
            name: name(),
          })}
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-1 text-[13px] leading-5 text-v2-text-text-muted">
        <span>{status()}</span>
        <Show when={props.kind === "reset"}>
          <span>{archived()}</span>
          <span>{language.t("workspace.reset.note")}</span>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="danger"
          data-action={`session-worktree-${props.kind}-confirm`}
          disabled={state.status === "loading"}
          onClick={() => {
            dialog.close()
            props.onConfirm()
          }}
        >
          {language.t(props.kind === "remove" ? "workspace.delete.button" : "workspace.reset.button")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}
