import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const viewSource = readFileSync(new URL("./subagent-list-view.tsx", import.meta.url), "utf8")

describe("subagent list rename + archive wiring", () => {
  test("child rows get an inline rename input committed through the rename API", () => {
    expect(viewSource).toContain('data-slot="subagent-rename-input"')
    expect(viewSource).toContain("api.session.rename")
    expect(viewSource).toContain('onKeyDown={(event) => {')
    // Cancel on Escape, commit on Enter/blur.
    expect(viewSource).toContain('"Escape"')
    expect(viewSource).toContain("onBlur={commitRename}")
  })

  test("rename validates non-empty titles and no-ops unchanged titles", () => {
    expect(viewSource).toContain("const next = draft.trim()")
    expect(viewSource).toContain("if (!next || next === props.child.title) return")
  })

  test("archive asks a confirmation dialog then archives via session.update", () => {
    expect(viewSource).toContain("confirmArchive")
    expect(viewSource).toContain("dialog.show")
    expect(viewSource).toContain("session.subagents.archive.confirm")
    expect(viewSource).toContain("client.session.update")
    expect(viewSource).toContain("time: { archived: Date.now() }")
    expect(viewSource).toContain('data-action="subagent-archive"')
  })

  test("archive only shows for finished children", () => {
    expect(viewSource).toContain("<Show when={props.finished}>")
    const archiveButton = viewSource.slice(viewSource.indexOf('data-action="subagent-archive"') - 400, viewSource.indexOf('data-action="subagent-archive"'))
    expect(archiveButton).toContain("props.finished")
  })

  test("user-visible copy is i18n keys, no hardcoded English", () => {
    expect(viewSource).toContain('language.t("session.subagents.archive")')
    expect(viewSource).toContain('language.t("session.subagents.archiving")')
    expect(viewSource).toContain('language.t("common.rename")')
    expect(viewSource).not.toMatch(/>\s*Archive\s*</)
    expect(viewSource).not.toMatch(/>\s*Rename\s*</)
  })
})

describe("subagent list stop + steer wiring", () => {
  test("stop aborts the child session with i18n copy and a stable hook", () => {
    expect(viewSource).toContain("client.session.abort")
    expect(viewSource).toContain('data-action="subagent-stop"')
    expect(viewSource).toContain('language.t("session.subagents.stop")')
    expect(viewSource).toContain('language.t("session.subagents.stopping")')
    expect(viewSource).toContain('language.t("session.subagents.stop.failed")')
  })

  test("steer prompts with explicit steer delivery and a stable hook", () => {
    expect(viewSource).toContain('delivery: "steer"')
    expect(viewSource).toContain('data-action="subagent-steer"')
    expect(viewSource).toContain('language.t("session.subagents.steer.send")')
    expect(viewSource).toContain('language.t("session.subagents.steer.sending")')
    expect(viewSource).toContain('language.t("session.subagents.steer.failed")')
  })

  test("steer input labels through the dedicated placeholder key", () => {
    expect(viewSource).toContain('aria-label={language.t("session.subagents.steer.placeholder")}')
    expect(viewSource).toContain('placeholder={language.t("session.subagents.steer.placeholder")}')
    expect(viewSource).not.toContain("dispatch.placeholder")
  })

  test("stop and steer copy is i18n keys, no hardcoded English", () => {
    expect(viewSource).not.toMatch(/>\s*Stop\s*</)
    expect(viewSource).not.toMatch(/>\s*Steer\s*</)
  })
})