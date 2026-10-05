import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { autoArchiveAfterPrClose } from "./ci-status-auto-archive"
import { FAILED_STATES, checkDotClass, summaryKey } from "./ci-status-helpers"

const stripSource = readFileSync(new URL("./ci-status.tsx", import.meta.url), "utf8")
const helpersSource = readFileSync(new URL("./ci-status-helpers.ts", import.meta.url), "utf8")

describe("ci status strip wiring", () => {
  test("renders a compact strip under the session header", () => {
    expect(stripSource).toContain('data-component="ci-status-strip"')
    expect(stripSource).toContain('data-slot="ci-check-summary"')
  })

  test("wires the PR endpoint through the directory-scoped SDK", () => {
    expect(stripSource).toContain("client.pullRequest.status")
    expect(stripSource).toContain("client.pullRequest.merge")
    expect(stripSource).toContain("sdk().directory")
  })

  test("auto-fix sends failing check names as a steer prompt to the current session", () => {
    expect(stripSource).toContain('delivery: "steer"')
    expect(stripSource).toContain("client.session.prompt")
    expect(stripSource).toContain("FAILED_STATES.has(check.state)")
  })

  test("auto-merge requires a one-time confirm dialog and reports raw gh failures", () => {
    expect(stripSource).toContain("dialog.show")
    expect(stripSource).toContain("session.ci.action.autoMerge.confirm")
  })

  test("mount fetch plus on-demand refresh only, no long polling", () => {
    expect(stripSource).toContain("onMount")
    expect(stripSource).toContain("data-action=\"ci-status-refresh\"")
    expect(stripSource).not.toMatch(/setInterval|EventSource/)
  })

  test("no-PR is a quiet hidden state, not an error banner", () => {
    expect(stripSource).toContain("prLoadError(error)")
    expect(helpersSource).toContain('{ kind: "hidden" }')
    expect(helpersSource).toContain('name === "GhNoPrError"')
  })

  test("gh missing links to the official install page opened externally", () => {
    expect(helpersSource).toContain("https://cli.github.com/")
    expect(stripSource).toContain("platform.openExternal(GH_DOCS_URL)")
  })

  test("notification path reuses platform.notify behind a focus check", () => {
    expect(stripSource).toContain("platform.notify")
    expect(stripSource).toContain("document.hasFocus()")
    expect(stripSource).not.toContain("notification.tsx")
  })

  test("auto-archive decision runs app-side off the settings toggle", () => {
    expect(stripSource).toContain("autoArchiveAfterPrClose")
    expect(stripSource).toContain("settings.cleanup.autoArchiveAfterPrClose")
    expect(stripSource).toContain("client.session.update")
  })

  test("user-visible copy uses i18n keys only", () => {
    expect(stripSource).toContain('language.t("session.ci.checks.passing")')
    expect(stripSource).not.toMatch(/>Install gh<|>Refresh<|>Auto-merge<|>Auto-fix</)
  })

  test("the strip is mounted inside the session header without touching other files", () => {
    const headerSource = readFileSync(new URL("./session-header.tsx", import.meta.url), "utf8")
    expect(headerSource).toContain("CiStatusStrip")
  })
})

describe("ci strip helpers", () => {
  test("summary key prefers failure over pending over passing", () => {
    expect(
      summaryKey([
        { name: "build", state: "PENDING" },
        { name: "test", state: "FAILURE" },
      ]),
    ).toBe("session.ci.checks.failing")
    expect(summaryKey([{ name: "build", state: "PENDING" }])).toBe("session.ci.checks.pending")
    expect(summaryKey([{ name: "build", state: "SUCCESS" }])).toBe("session.ci.checks.passing")
    expect(summaryKey([])).toBe("session.ci.checks.empty")
  })

  test("dot classes cover every declared state", () => {
    expect(checkDotClass("SUCCESS")).toContain("success")
    expect(checkDotClass("FAILURE")).toContain("error")
    expect(checkDotClass("ERROR")).toContain("error")
    expect(checkDotClass("CANCELLED")).toContain("error")
    expect(checkDotClass("PENDING")).toContain("warning")
    expect(checkDotClass("SKIPPED")).toBeTruthy()
  })

  test("only failure-family states count as failed", () => {
    expect(FAILED_STATES.has("FAILURE")).toBe(true)
    expect(FAILED_STATES.has("ERROR")).toBe(true)
    expect(FAILED_STATES.has("CANCELLED")).toBe(true)
    expect(FAILED_STATES.has("SUCCESS")).toBe(false)
    expect(FAILED_STATES.has("PENDING")).toBe(false)
    expect(FAILED_STATES.has("SKIPPED")).toBe(false)
  })
})

describe("auto-archive decision", () => {
  test("default-off setting means never archive", () => {
    expect(
      autoArchiveAfterPrClose({
        prState: "MERGED",
        sessionRunning: false,
        sessionArchived: false,
        settingEnabled: false,
      }),
    ).toBe("none")
  })

  test("archives only for merged/closed, idle, unarchived sessions", () => {
    expect(
      autoArchiveAfterPrClose({ prState: "MERGED", sessionRunning: false, sessionArchived: false, settingEnabled: true }),
    ).toBe("archive")
    expect(
      autoArchiveAfterPrClose({ prState: "OPEN", sessionRunning: false, sessionArchived: false, settingEnabled: true }),
    ).toBe("wait")
    expect(
      autoArchiveAfterPrClose({ prState: "MERGED", sessionRunning: true, sessionArchived: false, settingEnabled: true }),
    ).toBe("wait")
    expect(
      autoArchiveAfterPrClose({ prState: "MERGED", sessionRunning: false, sessionArchived: true, settingEnabled: true }),
    ).toBe("none")
  })
})