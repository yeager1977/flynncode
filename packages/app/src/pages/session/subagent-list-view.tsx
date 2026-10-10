import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  expandSubagent,
  groupSubagents,
  mergeSubagents,
  subagentListState,
  subagentPreview,
  tasksFromParts,
  type SubagentChild,
} from "./subagent-list"

export function SubagentList(props: { sessionID: () => string }) {
  const sync = useSync()
  const language = useLanguage()
  const { view } = useSessionLayout()

  const rows = createMemo(() => {
    const id = props.sessionID()
    if (!id) return []
    const sessions = Object.values(sync().data.session ?? {})
      .filter((session) => session.parentID === id)
      .map((session) => ({
        id: session.id,
        title: session.title,
        updated: session.time.updated,
        directory: session.directory,
        status: sync().data.session_status[session.id]?.type,
        text: latestText(sync().data.message[session.id] ?? [], sync().data.part),
      }))
    const parts = (sync().data.message[id] ?? []).flatMap((message) => sync().data.part[message.id] ?? [])
    const live = (childID: string) => {
      const type = sync().data.session_status[childID]?.type
      return type === "busy" || type === "retry"
    }
    return mergeSubagents(sessions, tasksFromParts(parts, Date.now(), live))
  })

  const groups = createMemo(() => groupSubagents(rows()))

  createEffect(() => {
    const expanded = view().subagents.expandedID()
    if (!expanded) return
    if (rows().some((child) => child.id === expanded)) return
    view().subagents.setExpandedID(undefined)
  })

  const open = (child: SubagentChild, finished: boolean) => {
    const result = expandSubagent(
      { expandedID: view().subagents.expandedID(), finishedOpen: view().subagents.finishedOpen() },
      { id: child.id, finished },
    )
    view().subagents.setExpandedID(result.expandedID)
    view().subagents.setFinishedOpen(result.finishedOpen)
    // Rows only carry the latest preview text; load the full child transcript.
    if (result.expandedID) void sync().session.sync(result.expandedID)
  }

  return (
    <Show
      when={subagentListState(rows()) === "list"}
      fallback={<div class="p-2 text-12-regular text-text-weak">{language.t("session.subagents.empty")}</div>}
    >
      <div class="flex flex-col gap-2 p-2 text-12-regular text-text-base">
        <For each={groups().active}>{(child) => <Row child={child} finished={false} open={open} />}</For>
        <Show when={groups().finished.length > 0}>
          <button
            type="button"
            class="text-start text-text-weak"
            aria-expanded={view().subagents.finishedOpen()}
            onClick={() => view().subagents.setFinishedOpen(!view().subagents.finishedOpen())}
          >
            {language.t("session.subagents.finished")} {groups().finished.length}
          </button>
          <Show when={view().subagents.finishedOpen()}>
            <For each={groups().finished}>{(child) => <Row child={child} finished={true} open={open} />}</For>
          </Show>
        </Show>
      </div>
    </Show>
  )
}

function Row(props: {
  child: SubagentChild
  finished: boolean
  open: (child: SubagentChild, finished: boolean) => void
}) {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const { view } = useSessionLayout()
  const dialog = useDialog()
  const expanded = () => view().subagents.expandedID() === props.child.id
  const [steer, setSteer] = createSignal("")
  const [stopping, setStopping] = createSignal(false)
  const [steering, setSteering] = createSignal(false)
  const [rename, setRename] = createSignal<string | undefined>()
  const [archiving, setArchiving] = createSignal(false)
  const status = () =>
    props.child.status === "busy" || props.child.status === "retry"
      ? language.t("session.subagents.running")
      : language.t("session.subagents.idle")
  const text = createMemo(() => {
    if (!expanded()) return []
    return (sync().data.message[props.child.id] ?? []).flatMap((message) =>
      (sync().data.part[message.id] ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
  })

  const commitRename = () => {
    const draft = rename()
    if (draft === undefined) return
    setRename(undefined)
    const next = draft.trim()
    if (!next || next === props.child.title) return
    void sdk()
      .api.session.rename({ sessionID: props.child.id, title: next })
      .catch(() => {
        // Keep the previous title visible on failure; the rename affordance
        // simply closes without erroring the panel.
      })
  }

  const archiveChild = async () => {
    if (archiving()) return
    setArchiving(true)
    try {
      await sdk().client.session.update({
        sessionID: props.child.id,
        time: { archived: Date.now() },
      })
      if (expanded()) props.open(props.child, props.finished)
    } catch {
      // Archive failures leave the row untouched; the list refreshes from sync.
    } finally {
      setArchiving(false)
    }
  }

  const confirmArchive = () => {
    dialog.show(() => (
      <Dialog title={language.t("session.subagents.archive.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <span class="text-14-regular text-text-strong">
            {language.t("session.subagents.archive.confirm", { title: props.child.title })}
          </span>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              disabled={archiving()}
              onClick={() => {
                dialog.close()
                void archiveChild()
              }}
            >
              {language.t("session.subagents.archive")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const stopChild = async () => {
    if (stopping()) return
    setStopping(true)
    try {
      // Run state lives in the target's instance: a worktree-isolated subagent
      // runs under its worktree directory (same pattern as tool/message.ts:57-60).
      await sdk().client.session.abort({ sessionID: props.child.id, directory: props.child.directory })
    } catch {
      showToast({ title: language.t("session.subagents.stop.failed") })
    } finally {
      setStopping(false)
    }
  }

  const submitSteer = async (event: SubmitEvent) => {
    event.preventDefault()
    const text = steer().trim()
    if (!text || steering()) return
    setSteering(true)
    try {
      await sdk().client.session.prompt({
        sessionID: props.child.id,
        parts: [{ type: "text", text }],
        delivery: "steer",
        directory: props.child.directory,
      })
      setSteer("")
    } catch {
      showToast({ title: language.t("session.subagents.steer.failed") })
    } finally {
      setSteering(false)
    }
  }

  return (
    <div
      class="flex flex-col gap-1 rounded-md border border-border-weak-base bg-v2-background-bg-layer-02 px-2 py-1.5"
      data-action="session-task-chip"
      data-expanded={expanded() ? "true" : "false"}
    >
      <Show
        when={rename() !== undefined}
        fallback={
          <button
            type="button"
            class="text-start"
            aria-expanded={expanded()}
            onClick={() => props.open(props.child, props.finished)}
          >
            <div dir="auto" class="text-14-regular text-text-strong" style={{ "font-weight": "560" }}>
              <bdi>{props.child.title}</bdi>
            </div>
            <span class="text-text-weak"> {status()}</span>
            <Show when={!expanded() && subagentPreview(props.child.text)}>
              <div class="text-text-weak line-clamp-2">
                <bdi dir="auto">{subagentPreview(props.child.text)}</bdi>
              </div>
            </Show>
          </button>
        }
      >
        <InlineInput
          data-slot="subagent-rename-input"
          class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-14-regular text-text-strong"
          value={rename()}
          aria-label={language.t("common.rename")}
          ref={(el) => requestAnimationFrame(() => el.focus())}
          onInput={(event) => setRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              event.preventDefault()
              commitRename()
              return
            }
            if (event.key === "Escape") {
              event.preventDefault()
              setRename(undefined)
            }
          }}
          onBlur={commitRename}
        />
      </Show>
      <Show when={expanded() && rename() === undefined}>
        <div class="flex gap-1">
          <Button
            type="button"
            size="small"
            variant="ghost"
            onClick={() => {
              setRename(props.child.title)
            }}
          >
            {language.t("common.rename")}
          </Button>
          <Show when={props.finished}>
            <Button
              type="button"
              size="small"
              variant="ghost"
              disabled={archiving()}
              data-action="subagent-archive"
              onClick={confirmArchive}
            >
              {archiving() ? language.t("session.subagents.archiving") : language.t("session.subagents.archive")}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={expanded() && (props.child.status === "busy" || props.child.status === "retry")}>
        <Button
          type="button"
          size="small"
          variant="ghost"
          data-action="subagent-stop"
          disabled={stopping()}
          onClick={() => {
            void stopChild()
          }}
        >
          {stopping() ? language.t("session.subagents.stopping") : language.t("session.subagents.stop")}
        </Button>
        <form
          class="flex gap-1"
          data-action="subagent-steer"
          onSubmit={(event) => {
            void submitSteer(event)
          }}
        >
          <input
            class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-12-regular"
            value={steer()}
            aria-label={language.t("session.subagents.steer.placeholder")}
            placeholder={language.t("session.subagents.steer.placeholder")}
            onInput={(event) => setSteer(event.currentTarget.value)}
          />
          <Button type="submit" size="small" variant="ghost" disabled={steering() || steer().trim() === ""}>
            {steering() ? language.t("session.subagents.steer.sending") : language.t("session.subagents.steer.send")}
          </Button>
        </form>
      </Show>
      <Show when={expanded()}>
        <div
          dir="auto"
          data-slot="session-task-output"
          class="max-h-48 overflow-y-auto text-13-regular text-text-weak whitespace-pre-wrap break-words"
        >
          <For each={text()}>{(item) => <div dir="auto">{item}</div>}</For>
        </div>
      </Show>
    </div>
  )
}

function latestText(
  messages: readonly { id: string }[],
  parts: Record<string, readonly { type: string; text?: string }[] | undefined>,
) {
  for (const message of messages.toReversed()) {
    for (const part of (parts[message.id] ?? []).toReversed()) {
      if (part.type === "text" && part.text) return part.text
    }
  }
  return ""
}
