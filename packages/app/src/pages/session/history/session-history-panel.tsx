import { createMemo, createSignal, For } from "solid-js"
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
  const [consented, setConsented] = createSignal(loadHistoryConsent(props.sessionID))
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
    setConsented(next)
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
    <section aria-label={language.t("history.title")}>
      <input
        type="search"
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
        placeholder={language.t("history.search.placeholder")}
        aria-label={language.t("history.search.placeholder")}
      />
      <button type="button" onClick={toggleConsent}>
        {consented() ? language.t("history.consent.disable") : language.t("history.consent.enable")}
      </button>
      <button type="button" onClick={exportHistory}>
        {language.t("history.export")}
      </button>
      <ul>
        <For each={entries()} fallback={<li>{language.t("history.empty")}</li>}>
          {(entry) => (
            <li>
              <span>{kindLabel(entry.kind)}</span> <span>{entry.title}</span>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
