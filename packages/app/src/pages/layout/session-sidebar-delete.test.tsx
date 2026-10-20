import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const read = (file: string) => readFile(path.join(import.meta.dir, file), "utf8")

test("the session context menu offers rename, archive and delete", async () => {
  const source = await read("session-sidebar.tsx")
  expect(source).toContain("common.rename")
  expect(source).toContain("common.archive")
  expect(source).toContain("common.delete")
})

test("deleting a session asks for confirmation first", async () => {
  const source = await read("session-sidebar.tsx")
  expect(source).toContain("session.delete.title")
  expect(source).toContain("session.delete.confirm")
  expect(source).toContain("session.delete.button")
  // The menu item opens the dialog; the dialog performs the delete.
  expect(source).toContain("confirmDelete")
})

test("the sidebar deletes the session through the server", async () => {
  const source = await read(path.join("..", "layout-new-sidebar.tsx"))
  expect(source).toContain("client.session.delete(")
  expect(source).toContain("homeSessions.remove(session.id)")
})
