import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createRoot } from "solid-js"
import type { Platform } from "@/context/platform"
import { createPromptReady, createPromptSession } from "@/context/prompt-state"
import { ServerScope } from "@/utils/server-scope"
import { createDraftStore } from "@/utils/draft-store"
import { Persist, removePersisted } from "@/utils/persist"

let read: ((value: string | null) => void) | undefined

const storage: AsyncStorage = {
  getItem: () => new Promise((resolve) => (read = resolve)),
  setItem: async () => undefined,
  removeItem: async () => undefined,
  clear: async () => undefined,
  key: async () => null,
  getLength: async () => 0,
  length: Promise.resolve(0),
}

const platform: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
  draftStore: {
    ...storage,
    putBlob: async () => {
      throw new Error("putBlob is not used by this test")
    },
  },
}

describe("prompt persistence", () => {
  test("waits for an async draft to hydrate before reporting ready", async () => {
    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const session = createPromptSession(ServerScope.local, { draftID: "draft-async" }, undefined, platform)
        const ready = createPromptReady(() => session)

        expect(ready()).toBe(false)
        expect(session.current()[0]).toMatchObject({ type: "text", content: "" })

        read?.(
          JSON.stringify({
            prompt: [{ type: "text", content: "persisted draft", start: 0, end: 15 }],
            cursor: 15,
            context: { items: [] },
          }),
        )

        createEffect(() => {
          if (!ready()) return
          try {
            expect(session.current()[0]).toMatchObject({ type: "text", content: "persisted draft" })
            dispose()
            resolve()
          } catch (error) {
            dispose()
            reject(error)
          }
        })
      })
    })
  })
})

test("moves legacy image data URLs into blobs and hydrates object URLs", async () => {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  const store = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => void documents.set(key, value),
    remove: async (key) => void documents.delete(key),
    putBlob: async (blob) => {
      const id = String(blob.size)
      blobs.set(id, blob)
      return id
    },
    getBlob: async (id) => blobs.get(id) ?? null,
  })

  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "image", dataUrl: "data:image/png;base64,YQ==" }] }))
  expect(documents.get("prompt")).not.toContain("dataUrl")
  const value = JSON.parse((await store.getItem("prompt"))!)
  expect(value.prompt[0].blob.id).toBe("1")
  expect(value.prompt[0].blob.url).toStartWith("blob:")
})

test("does not let delayed blob migration overwrite a newer draft", async () => {
  const documents = new Map<string, string>()
  const migration = Promise.withResolvers<void>()
  const store = createDraftStore({
    get: async () => null,
    set: async (key, value) => void documents.set(key, value),
    remove: async () => undefined,
    putBlob: async () => {
      await migration.promise
      return "blob"
    },
    getBlob: async () => null,
  })
  const older = store.setItem(
    "prompt",
    JSON.stringify({ prompt: [{ type: "image", dataUrl: "data:image/png;base64,YQ==" }] }),
  )
  await Bun.sleep(0)
  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "text", content: "latest" }] }))
  migration.resolve()
  await older

  expect(documents.get("prompt")).toContain("latest")
})

function recordingPlatform() {
  const writes: string[] = []
  const draft: AsyncStorage = {
    getItem: async () => null,
    setItem: async (_key, value) => void writes.push(value),
    removeItem: async () => undefined,
    clear: async () => undefined,
    key: async () => null,
    getLength: async () => 0,
    length: Promise.resolve(0),
  }
  const value: Platform = {
    ...platform,
    draftStore: {
      ...draft,
      putBlob: async () => {
        throw new Error("putBlob is not used by this test")
      },
    },
  }
  return { writes, platform: value }
}

async function readySession(draftID: string, target: Platform) {
  const owner = { dispose: () => {} }
  const session = createRoot((dispose) => {
    owner.dispose = dispose
    return createPromptSession(ServerScope.local, { draftID }, undefined, target)
  })
  await session.ready.promise
  await Bun.sleep(0)
  return { session, dispose: () => owner.dispose() }
}

const text = (content: string) => [{ type: "text" as const, content, start: 0, end: content.length }]
const written = (value: string | undefined) => (value ? JSON.parse(value).prompt[0]?.content : undefined)

describe("draft write debounce", () => {
  test("persists a burst of edits once, after the typing pause", async () => {
    const recording = recordingPlatform()
    const { session, dispose } = await readySession("draft-debounce", recording.platform)
    const before = recording.writes.length

    session.set(text("a"), 1)
    session.set(text("ab"), 2)
    session.set(text("abc"), 3)
    await Bun.sleep(50)
    expect(recording.writes.length).toBe(before)

    await Bun.sleep(400)
    expect(recording.writes.length).toBe(before + 1)
    expect(written(recording.writes.at(-1))).toBe("abc")
    dispose()
  })

  test("flushes the pending draft when the prompt is submitted", async () => {
    const recording = recordingPlatform()
    const { session, dispose } = await readySession("draft-submit", recording.platform)

    session.set(text("send me"), 7)
    session.reset()

    expect(written(recording.writes.at(-1))).toBe("")
    const count = recording.writes.length
    await Bun.sleep(400)
    expect(recording.writes.length).toBe(count)
    dispose()
  })

  test("flushes the pending draft when the page unloads", async () => {
    const recording = recordingPlatform()
    const { session, dispose } = await readySession("draft-unload", recording.platform)
    const before = recording.writes.length

    session.set(text("unsaved"), 7)
    window.dispatchEvent(new Event("pagehide"))

    expect(recording.writes.length).toBe(before + 1)
    expect(written(recording.writes.at(-1))).toBe("unsaved")
    dispose()
  })

  test("does not bring back a draft removed while its write is pending", async () => {
    const recording = recordingPlatform()
    const { session, dispose } = await readySession("draft-removed", recording.platform)
    const before = recording.writes.length

    session.set(text("closing tab"), 11)
    removePersisted(Persist.prompt(Persist.draft("draft-removed", "prompt")), recording.platform)
    dispose()
    await Bun.sleep(400)

    expect(recording.writes.length).toBe(before)
  })

  test("flushes the pending draft when the composer loses focus", async () => {
    const recording = recordingPlatform()
    const { session, dispose } = await readySession("draft-blur", recording.platform)
    const editor = document.createElement("div")
    editor.tabIndex = 0
    document.body.append(editor)
    editor.focus()

    session.set(text("half typed"), 10)
    editor.blur()

    expect(written(recording.writes.at(-1))).toBe("half typed")
    editor.remove()
    dispose()
  })
})
