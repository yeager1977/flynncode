import { describe, expect, mock, test } from "bun:test"
import { project } from "./markdown-stream"
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdown-worker-protocol"

// Bun cannot load Vite's `?worker&url` imports; point the client at the real worker module instead.
const workerUrl = new URL("./markdown.worker.ts", import.meta.url).href
mock.module("./markdown.worker.ts?worker&url", () => ({ default: workerUrl }))

const { disposeMarkdownProjection, projectMarkdown } = await import("./markdown-worker")

const intro = "# Plan\n\nFirst finished paragraph.\n\n```ts\nconst done = true\n```\n\n"
const tail = "Second paragraph is still"
const more = " streaming with more words"

function startWorker() {
  const worker = new Worker(workerUrl, { type: "module" })
  const responses: MarkdownWorkerResponse[] = []
  const waiters: Array<() => void> = []
  worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
    responses.push(event.data)
    waiters.splice(0).forEach((wake) => wake())
  }
  const next = async (count: number) => {
    while (responses.length < count) await new Promise<void>((resolve) => waiters.push(resolve))
    return responses[count - 1]!
  }
  return {
    post: (request: MarkdownWorkerRequest) => worker.postMessage(request),
    next,
    stop: () => worker.terminate(),
  }
}

describe("markdown worker diff protocol", () => {
  test("the worker accepts appended text and returns blocks from the first changed block", async () => {
    const worker = startWorker()
    worker.post({ type: "project", id: 1, key: "owner", offset: 0, text: intro + tail, live: true })
    const first = await worker.next(1)
    expect(first).toEqual({
      type: "project",
      id: 1,
      key: "owner",
      firstChangedBlock: 0,
      blocks: project(undefined, intro + tail, true).blocks,
    })

    worker.post({ type: "project", id: 2, key: "owner", offset: (intro + tail).length, text: more, live: true })
    const second = await worker.next(2)
    const full = project(undefined, intro + tail + more, true)
    expect(second).toEqual({
      type: "project",
      id: 2,
      key: "owner",
      firstChangedBlock: full.blocks.length - 1,
      blocks: full.blocks.slice(-1),
    })
    worker.stop()
  })

  test("the worker rejects appended text that does not continue its copy", async () => {
    const worker = startWorker()
    worker.post({ type: "project", id: 1, key: "owner", offset: 0, text: intro, live: true })
    await worker.next(1)
    worker.post({ type: "project", id: 2, key: "owner", offset: intro.length + 3, text: more, live: true })
    expect(await worker.next(2)).toMatchObject({ type: "error", id: 2, key: "owner" })
    worker.stop()
  })

  test("the client rebuilds full projections and keeps unchanged block objects", async () => {
    const key = "client-owner"
    const first = await projectMarkdown(key, intro + tail, true)
    const second = await projectMarkdown(key, intro + tail + more, true)
    expect(second).toEqual(project(undefined, intro + tail + more, true))
    expect(second.blocks.slice(0, -1).every((block, index) => block === first.blocks[index])).toBe(true)
    expect(second.blocks.at(-1)).not.toBe(first.blocks.at(-1))

    const done = await projectMarkdown(key, intro + tail + more, false)
    expect(done).toEqual(project(second, intro + tail + more, false))
    disposeMarkdownProjection(key)
  })

  test("the client resends the full text when the text is replaced", async () => {
    const key = "client-replace"
    await projectMarkdown(key, intro + tail, true)
    const replaced = await projectMarkdown(key, "Different answer", true)
    expect(replaced).toEqual(project(undefined, "Different answer", true))
    disposeMarkdownProjection(key)
  })
})
