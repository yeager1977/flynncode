import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const read = (file: string) => readFile(path.join(import.meta.dir, file), "utf8")

test("the waiting terminal dock names the subagent need and offers the terminal", async () => {
  const source = await read("session-waiting-terminal-dock.tsx")
  expect(source).toContain("session.waitingTerminal.title")
  expect(source).toContain("session.waitingTerminal.hint")
  expect(source).toContain("session.waitingTerminal.open")
  expect(source).toContain("onOpen")
})

test("the command stays LTR inside the card", async () => {
  const source = await read("session-waiting-terminal-dock.tsx")
  // Terminal command text is LTR regardless of the interface language.
  expect(source).toContain('dir="ltr"')
})

test("the composer region shows the card above the request docks", async () => {
  const source = await read("session-composer-region.tsx")
  const waiting = source.indexOf("<SessionWaitingTerminalDock")
  const question = source.indexOf("<SessionQuestionDock")
  const permission = source.indexOf("<SessionPermissionDock")
  expect(waiting).toBeGreaterThan(-1)
  expect(waiting).toBeLessThan(question)
  expect(waiting).toBeLessThan(permission)
})

test("the composer state surfaces the waiting terminal of a descendant session", async () => {
  const source = await read("session-composer-state.ts")
  expect(source).toContain("sessionWaitingTerminal")
  expect(source).toContain("waitingTerminal")
})

test("the session page opens the subagent terminal in the main session panel", async () => {
  const source = await read(path.join("..", "..", "session.tsx"))
  expect(source).toContain("onOpenWaitingTerminal")
  expect(source).toContain("terminal.adopt(ptyID)")
  expect(source).toContain("view().terminal.open()")
})

test("english dict carries the waiting terminal keys", async () => {
  const source = await read(path.join("..", "..", "..", "i18n", "en.ts"))
  expect(source).toContain('"session.waitingTerminal.title"')
  expect(source).toContain('"session.waitingTerminal.hint"')
  expect(source).toContain('"session.waitingTerminal.open"')
})
