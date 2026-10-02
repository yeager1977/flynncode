import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
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
        status: sync().data.session_status[session.id]?.type,
        text: latestText(sync().data.message[session.id] ?? [], sync().data.part),
      }))
    const parts = (sync().data.message[id] ?? []).flatMap((message) => sync().data.part[message.id] ?? [])
    return mergeSubagents(sessions, tasksFromParts(parts, Date.now()))
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
  const expanded = () => view().subagents.expandedID() === props.child.id
  const [steer, setSteer] = createSignal("")
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
  return (
    <div
      class="flex flex-col gap-1 rounded-md border border-border-weak-base bg-v2-background-bg-layer-02 px-2 py-1.5"
      data-action="session-task-chip"
      data-expanded={expanded() ? "true" : "false"}
    >
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
      <Show when={expanded() && (props.child.status === "busy" || props.child.status === "retry")}>
        <Button
          type="button"
          size="small"
          variant="ghost"
          onClick={() => {
            void sdk().client.session.abort({ sessionID: props.child.id })
          }}
        >
          {language.t("common.cancel")}
        </Button>
        <form
          class="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            const text = steer().trim()
            if (!text) return
            void sdk().client.session.prompt({
              sessionID: props.child.id,
              parts: [{ type: "text", text }],
            })
            setSteer("")
          }}
        >
          <input
            class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-12-regular"
            value={steer()}
            aria-label={language.t("dispatch.placeholder")}
            onInput={(event) => setSteer(event.currentTarget.value)}
          />
          <Button type="submit" size="small" variant="ghost">
            {language.t("session.followupDock.sendNow")}
          </Button>
        </form>
      </Show>
      <Show when={expanded()}>
        <div
          dir="auto"
          data-slot="session-task-output"
          class="max-h-48 overflow-y-auto text-13-regular text-text-weak whitespace-pre-wrap break-words"
          onClick={() => props.open(props.child, props.finished)}
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
