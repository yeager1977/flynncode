import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState } from "@/context/prompt-state"
import { createDraftStore } from "@/utils/draft-store"
import { preparePromptSubmission } from "@/components/prompt-input/submission-state"
import { attachReviewScreenshot, captureReviewAnnotation } from "@/pages/session/review-screenshot"
import type { BrowserAnnotationPayload } from "@/pages/session/hunk-revert"

function storage() {
  const id = crypto.randomUUID()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const blobs = new Map<string, Blob>()
  const driver = {
    get: async () => null,
    set: async () => {},
    remove: async () => {},
    putBlob: async (blob: Blob) => {
      started.resolve()
      await release.promise
      blobs.set(id, blob)
      return id
    },
    getBlob: async (id: string) => blobs.get(id) ?? null,
    discardBlob: async (id: string) => { blobs.delete(id) },
  }
  return { store: createDraftStore(driver), started, release, blobs }
}

const annotation = { file: "preview", id: "annotation", comment: "look here", screenshot: "data:image/png;base64,aGVsbG8=", rect: { x: 0, y: 0, width: 1, height: 1 } }
const imageCount = (prompt: ReturnType<typeof createPromptState>) => prompt.current().filter(part => part.type === "image").length

test("a delayed screenshot stays with its original session", async () => {
  const { a, b, dispose } = createRoot(dispose => ({ a: createPromptState({ prompt: "A" }), b: createPromptState({ prompt: "B" }), dispose }))
  const store = storage()
  let active = a
  const work = attachReviewScreenshot({ ...annotation, prompt: () => active, draftStore: store.store, updateComment: () => {} })
  await store.started.promise
  active = b
  store.release.resolve()
  await work
  expect(imageCount(a)).toBe(1)
  expect(imageCount(b)).toBe(0)
  dispose()
})

test("reset before persistence completes discards the capture and its blob", async () => {
  const { prompt, dispose } = createRoot(dispose => ({ prompt: createPromptState({ prompt: "first" }), dispose }))
  const store = storage()
  const work = attachReviewScreenshot({ ...annotation, prompt: () => prompt, draftStore: store.store, updateComment: () => {} })
  await store.started.promise
  prompt.reset()
  prompt.set([{ type: "text", content: "next", start: 0, end: 4 }])
  store.release.resolve()
  await work
  expect(imageCount(prompt)).toBe(0)
  expect(store.blobs.size).toBe(0)
  dispose()
})

test("submission waits for the original draft's screenshot and includes text and image together", async () => {
  const { prompt, dispose } = createRoot(dispose => ({ prompt: createPromptState({ prompt: "first" }), dispose }))
  prompt.context.add({ type: "file", path: "preview", comment: "look here", commentID: "annotation" })
  const store = storage()
  const work = attachReviewScreenshot({ ...annotation, prompt: () => prompt, draftStore: store.store, updateComment: () => {} })
  await store.started.promise
  const submission = preparePromptSubmission(prompt.capture())
  store.release.resolve()
  await work
  const sent = await submission
  if (!sent) throw new Error("submission unexpectedly invalidated")
  expect(sent.prompt.filter(part => part.type === "image")).toHaveLength(1)
  expect(sent.context).toMatchObject([{ comment: "look here", commentID: "annotation" }])
  sent.clear()
  expect(imageCount(prompt)).toBe(0)
  dispose()
})

test("a native capture completing after a session switch is discarded before annotation delivery", async () => {
  const { a, b, dispose } = createRoot(dispose => ({ a: createPromptState(), b: createPromptState(), dispose }))
  let active = a
  const capture = Promise.withResolvers<BrowserAnnotationPayload>()
  const work = captureReviewAnnotation({ prompt: () => active, capture: () => capture.promise, deliver: payload => active.context.add({ type: "file", path: payload.file, comment: payload.comment }) })
  active = b
  capture.resolve({ ...annotation, comment: "from A" })
  expect(await work).toBe(false)
  expect(b.context.items()).toEqual([])
  dispose()
})

test("submission waits through native capture and subsequent blob persistence", async () => {
  const { prompt, dispose } = createRoot(dispose => ({ prompt: createPromptState({ prompt: "first" }), dispose }))
  const capture = Promise.withResolvers<BrowserAnnotationPayload>()
  const store = storage()
  const work = captureReviewAnnotation({ prompt: () => prompt, capture: () => capture.promise, deliver: payload => {
    prompt.context.add({ type: "file", path: payload.file, comment: payload.comment, commentID: "annotation" })
    void attachReviewScreenshot({ ...annotation, prompt: () => prompt, draftStore: store.store, updateComment: () => {} })
  } })
  const submission = preparePromptSubmission(prompt.capture())
  capture.resolve(annotation)
  await store.started.promise
  store.release.resolve()
  await work
  const sent = await submission
  if (!sent) throw new Error("submission unexpectedly invalidated")
  expect(sent.prompt.filter(part => part.type === "image")).toHaveLength(1)
  expect(sent.context).toHaveLength(1)
  dispose()
})

test("persistence failure updates only the captured session's fallback comment", async () => {
  const { a, b, dispose } = createRoot(dispose => ({ a: createPromptState(), b: createPromptState(), dispose }))
  a.context.add({ type: "file", path: "preview", comment: "from A", commentID: "annotation" })
  b.context.add({ type: "file", path: "preview", comment: "from B", commentID: "annotation" })
  let active = a
  const store = storage()
  const work = attachReviewScreenshot({ ...annotation, prompt: () => active, draftStore: store.store, updateComment: () => {} })
  await store.started.promise
  active = b
  store.release.reject(new Error("storage refused"))
  await work
  expect(a.context.items()[0].comment).toContain("data:image/png")
  expect(b.context.items()[0].comment).toBe("from B")
  dispose()
})

test("disposing a draft discards a pending stored capture", async () => {
  const { prompt, dispose } = createRoot(dispose => ({ prompt: createPromptState(), dispose }))
  const store = storage()
  const work = attachReviewScreenshot({ ...annotation, prompt: () => prompt, draftStore: store.store, updateComment: () => {} })
  await store.started.promise
  dispose()
  store.release.resolve()
  await work
  expect(store.blobs.size).toBe(0)
})
