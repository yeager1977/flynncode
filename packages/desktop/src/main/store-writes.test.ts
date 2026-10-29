import { expect, test } from "bun:test"
import { createStoreWrites } from "./store-writes"

function setup(delay = 20) {
  const writes: [string, Record<string, unknown>][] = []
  return { writes, store: createStoreWrites((name, values) => writes.push([name, values]), delay) }
}

test("writes each store once per burst with the latest values", async () => {
  const { writes, store } = setup()
  store.set("opencode.global.dat", "layout", "a")
  store.set("opencode.global.dat", "layout", "b")
  store.set("opencode.global.dat", "server", "s")
  store.set("default.dat", "x", "1")
  expect(writes).toEqual([])

  await Bun.sleep(40)

  expect(writes).toEqual([
    ["opencode.global.dat", { layout: "b", server: "s" }],
    ["default.dat", { x: "1" }],
  ])
})

test("serves buffered values before they reach the file", () => {
  const { store } = setup()
  store.set("opencode.global.dat", "layout", "newer")
  expect(store.pending("opencode.global.dat", "layout")).toBe("newer")
  expect(store.pending("opencode.global.dat", "other")).toBeUndefined()
  store.flush()
})

test("drops buffered values for deleted keys and cleared stores", async () => {
  const { writes, store } = setup()
  store.set("a.dat", "gone", "1")
  store.set("a.dat", "kept", "2")
  store.set("b.dat", "cleared", "3")
  store.drop("a.dat", "gone")
  store.drop("b.dat")

  await Bun.sleep(40)

  expect(writes).toEqual([["a.dat", { kept: "2" }]])
})

test("flushes one store or all stores on demand", () => {
  const { writes, store } = setup(10_000)
  store.set("a.dat", "k", "1")
  store.set("b.dat", "k", "2")

  store.flush("a.dat")
  expect(writes).toEqual([["a.dat", { k: "1" }]])

  store.flush()
  expect(writes).toEqual([
    ["a.dat", { k: "1" }],
    ["b.dat", { k: "2" }],
  ])
})
