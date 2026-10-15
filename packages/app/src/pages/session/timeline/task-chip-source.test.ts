import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const timelineSource = readFileSync(new URL("./message-timeline.tsx", import.meta.url), "utf8")
const rowsSource = readFileSync(new URL("./rows.ts", import.meta.url), "utf8")
const timelineRowSource = readFileSync(new URL("./timeline-row.ts", import.meta.url), "utf8")

describe("session task chip wiring", () => {
  test("rows parse the envelope and emit a chip row after the turn's parts", () => {
    expect(rowsSource).toContain("task-suggestion")
    expect(rowsSource).toContain("taskSuggestionFromMessages")
    expect(timelineRowSource).toMatch(/export class TaskSuggestion extends Data\.TaggedClass\("TaskSuggestion"\)/)
    expect(timelineRowSource).toContain("task-suggestion:")
  })

  test("the chip is an interactive row with its own data-action", () => {
    // Subagent rows own "session-task-chip"; suggestions must not share it.
    expect(timelineSource).toContain('data-action="session-task-suggestion"')
    expect(timelineSource).not.toContain('data-action="session-task-chip"')
    expect(timelineSource).toContain('data-slot="session-task-suggestion"')
    expect(timelineSource).toContain('case "TaskSuggestion"')
  })

  test("chip click runs the worktree new-session flow, not a custom transport", () => {
    expect(timelineSource).toContain("client.worktree.create")
    expect(timelineSource).toContain("WorktreeState.pending")
    // The prompt reaches the draft composer through the ?prompt= route query,
    // the same path deep links use.
    expect(timelineSource).toContain("session?prompt=")
    expect(timelineSource).toContain("startTaskSession(chipRow().prompt)")
  })

  test("chip click confirms before creating a worktree", () => {
    expect(timelineSource).toContain("<DialogStartTaskSession")
    expect(timelineSource).toContain('language.t("session.taskSuggestion.confirm.title")')
  })

  test("the chip label is model-provided, not app copy", () => {
    // The chip text comes from the envelope fields; nothing app-authored is
    // rendered inside the button besides an icon.
    expect(timelineSource).toContain("{chipRow().title}")
    expect(timelineSource).not.toMatch(/data-slot="session-task-suggestion"[\s\S]{0,400}>(?![^{])\s*[A-Z][a-z]+ [a-z]+/)
  })

  test("settled body text hides the envelope the chip represents", () => {
    expect(rowsSource).toContain("hideTrailingSuggestion")
    expect(timelineSource).toContain("hideTrailingSuggestion")
    expect(timelineSource).toContain("TaskSuggestion.strip")
  })
})
