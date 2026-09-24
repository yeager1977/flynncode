import { For, Show, createEffect, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { expandSubagent, groupSubagents, mergeSubagents, subagentPreview, tasksFromParts, type SubagentChild } from "./subagent-list"

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
    <Show when={groups().active.length + groups().finished.length > 0}>
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
  const { view } = useSessionLayout()
  const expanded = () => view().subagents.expandedID() === props.child.id
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
    <div class="flex flex-col gap-1 border-s border-border-weak ps-2">
      <button type="button" class="text-start" onClick={() => props.open(props.child, props.finished)}>
        <bdi dir="auto">{props.child.title}</bdi>
        <span class="text-text-weak"> {status()}</span>
        <div class="text-text-weak">
          <bdi dir="auto">{subagentPreview(props.child.text)}</bdi>
        </div>
      </button>
      <Show when={expanded()}>
        <div dir="auto" class="flex flex-col gap-2">
          <For each={text()}>{(item) => <div dir="auto" class="whitespace-pre-wrap break-words">{item}</div>}</For>
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