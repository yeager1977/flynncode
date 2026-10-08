import { createMemo, createSignal, For } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { useLanguage } from "@/context/language"
import {
  deriveSessionHistory,
  filterHistoryEntries,
  type HistoryEntryKind,
} from "@/pages/session/history/session-history"
import { loadHistoryConsent, saveHistoryConsent } from "@/pages/session/history/history-consent"
import type { StoredArtifact } from "@/pages/layout/sidebar-artifacts"
import type { SessionExportData } from "@/utils/session-export"

export function SessionHistoryPanel(props: {
  sessionID: string
  messages: SessionExportData["messages"]
  diffs: FileDiffInfo[]
  stored: StoredArtifact[]
}) {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  // Consent is per session: derive it from the current session id so a
  // session switch never carries the previous session's choice along.
  const [consent, setConsent] = createStore<Record<string, boolean>>({})
  const consented = () => consent[props.sessionID] ?? loadHistoryConsent(props.sessionID)
  const entries = createMemo(() => {
    const base = deriveSessionHistory({
      sessionID: props.sessionID,
      messages: props.messages,
      diffs: props.diffs,
      stored: props.stored,
    })
    const visible = props.stored.filter((artifact) => {
      if (artifact.sessionID !== props.sessionID) return false
      if (artifact.type !== "screenshot") return false
      return consented()
    })
    const withPixels = [
      ...base,
      ...visible.map((artifact) => ({
        id: artifact.id,
        time: artifact.created,
        kind: "note" as const,
        title: language.t("history.kind.note"),
        detail: artifact.type === "screenshot" ? (artifact.note ?? artifact.url) : "",
        sessionID: props.sessionID,
      })),
    ]
    withPixels.sort((a, b) => a.time - b.time)
    return filterHistoryEntries(withPixels, query())
  })

  function kindLabel(kind: HistoryEntryKind) {
    if (kind === "run") return language.t("history.kind.run")
    if (kind === "change") return language.t("history.kind.change")
    if (kind === "approval") return language.t("history.kind.approval")
    return language.t("history.kind.note")
  }

  function toggleConsent() {
    const next = !consented()
    setConsent(props.sessionID, next)
    saveHistoryConsent(props.sessionID, next)
  }

  function exportHistory() {
    const blob = new Blob([JSON.stringify(entries(), null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `history-${props.sessionID}.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  return (
    <section aria-label={language.t("history.title")} class="flex flex-col gap-3 pt-3">
      <TextField
        variant="ghost"
        type="search"
        value={query()}
        onChange={setQuery}
        placeholder={language.t("history.search.placeholder")}
        aria-label={language.t("history.search.placeholder")}
        spellcheck={false}
        autocomplete="off"
      />
      <div class="flex items-center justify-between gap-2">
        <Switch checked={consented()} onChange={toggleConsent}>
          {language.t("history.consent.enable")}
        </Switch>
        <Button size="small" variant="ghost" onClick={exportHistory}>
          {language.t("history.export")}
        </Button>
      </div>
      <ul class="flex flex-col gap-1">
        <For
          each={entries()}
          fallback={<li class="px-2 py-2 text-12-regular text-text-weak">{language.t("history.empty")}</li>}
        >
          {(entry) => (
            <li class="flex min-w-0 items-baseline gap-2 px-2 py-1 text-12-regular">
              <span class="shrink-0 text-text-weak">{kindLabel(entry.kind)}</span>
              <span class="min-w-0 truncate text-text-strong" title={entry.title}>
                {entry.title}
              </span>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
