import { test } from "node:test"
import { equal, notEqual } from "node:assert/strict"
import { createDesktopDraftStore } from "./draft-store.ts"

test("discarding a stale capture removes only unreferenced blobs", () => {
  const store = createDesktopDraftStore(":memory:")
  const id = store.putBlob(new TextEncoder().encode("shared"))
  store.set("prompt", JSON.stringify({ prompt: [{ type: "image", blob: { id } }] }))
  store.discardBlob(id)
  notEqual(store.getBlob(id), null)
  store.set("prompt", JSON.stringify({ prompt: [] }))
  store.discardBlob(id)
  equal(store.getBlob(id), null)
  store.close()
})
