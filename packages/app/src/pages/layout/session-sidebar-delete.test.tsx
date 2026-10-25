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

test("the sidebar mounts the delete confirmation through dialog.show", async () => {
  const source = await read("session-sidebar.tsx")
  // The ui Dialog renders Kobalte.Content only; it has to be mounted through
  // the DialogProvider (dialog.show) so a Kobalte.Dialog.Root wrapper exists —
  // a Dialog rendered directly in the sidebar tree throws
  // "[kobalte]: `useDialogContext` must be used within a `Dialog` component".
  expect(source).toContain("dialog.show(")
  expect(source).not.toContain("<Show when={deleting.session}")
})

test("the sidebar deletes the session through the server", async () => {
  const source = await read(path.join("..", "layout-new-sidebar.tsx"))
  expect(source).toContain("client.session.delete(")
  expect(source).toContain("homeSessions.remove(session.id)")
})
