import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useFilteredList } from "@flynncode/ui/hooks"

type Request = { query: string; signal?: AbortSignal; resolve: (items: string[]) => void }

function mount(debounce?: number) {
  const requests: Request[] = []
  const owner = { dispose: () => {} }
  const list = createRoot((dispose) => {
    owner.dispose = dispose
    return useFilteredList<string>({
      items: (query, signal) =>
        query ? new Promise<string[]>((resolve) => requests.push({ query, signal, resolve })) : ["agent", "reference"],
      key: (item) => item,
      skipFilter: () => true,
      debounce,
    })
  })
  return { list, requests, dispose: () => owner.dispose() }
}

describe("filtered list search", () => {
  test("waits for a typing pause before searching", async () => {
    const view = mount(40)

    view.list.onInput("s")
    view.list.onInput("sr")
    view.list.onInput("src")
    expect(view.list.filter()).toBe("src")
    expect(view.requests).toHaveLength(0)

    await Bun.sleep(80)
    expect(view.requests.map((request) => request.query)).toEqual(["src"])
    view.dispose()
  })

  test("aborts a superseded search and ignores its late result", async () => {
    const view = mount(0)

    view.list.onInput("a")
    await Bun.sleep(10)
    view.list.onInput("ab")
    await Bun.sleep(10)

    expect(view.requests.map((request) => request.query)).toEqual(["a", "ab"])
    expect(view.requests[0]?.signal?.aborted).toBe(true)
    expect(view.requests[1]?.signal?.aborted).toBe(false)

    view.requests[1]?.resolve(["ab-file"])
    await Bun.sleep(0)
    view.requests[0]?.resolve(["a-file"])
    await Bun.sleep(10)
    expect(view.list.flat()).toEqual(["ab-file"])
    view.dispose()
  })

  test("aborts the pending search when the list is disposed", async () => {
    const view = mount(0)
    view.list.onInput("a")
    await Bun.sleep(10)
    view.dispose()
    expect(view.requests[0]?.signal?.aborted).toBe(true)
  })

  test("searches immediately without a debounce", async () => {
    const view = mount()
    view.list.onInput("x")
    expect(view.requests.map((request) => request.query)).toEqual(["x"])
    view.dispose()
  })
})
